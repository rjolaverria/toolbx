import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  CustomToolExecutor,
  Logger,
  RegisteredToolView,
  RouteResult,
  RoutedCallToolResult,
} from '@toolbox/core';
import {
  describeTool as defaultDescribeTool,
  digestToolSources,
  readToolManifest as defaultReadToolManifest,
  resolveToolEntryPath,
  runTool as defaultRunTool,
  ToolManifestError,
  type DescribeOutcome,
  type RunOutcome,
  type SandboxOptions,
  type ToolManifest,
} from '@toolbox/custom-tools';

import type { CustomToolInput } from '../registry/index.js';

/**
 * `_meta` key stamped onto every custom-tool descriptor in `tools/list`. It
 * marks a tool's provenance as an imported custom tool (P3-05) so control-plane
 * consumers (`tlbx run` discovery) can label it `custom` rather than inferring
 * source from the namespace, mirroring `BOOTSTRAP_TOOL_META_KEY`.
 */
export const CUSTOM_TOOL_META_KEY = 'toolbox/custom';

/** Namespace reserved for ToolBox's own bootstrap/internal tools (`toolbox__*`). */
const RESERVED_NAMESPACE = 'toolbox';

/**
 * Bridges imported custom tools (P3-05) into the gateway. `load()` reads the
 * manifest, resolves each enabled tool's `inputSchema` via the custom-tool
 * sandbox (without executing the handler), and returns the registry inputs the
 * runtime publishes into `tools/list`. `executor` runs a custom tool through the
 * same sandbox and maps its outcome onto the router's {@link RouteResult}.
 *
 * `@toolbox/core` cannot depend on `@toolbox/custom-tools`, so the router takes
 * the executor as an injected seam; this host is where the gateway wires the two
 * together.
 */
export interface CustomToolHostDeps {
  /** Absolute ToolBox config directory (parent of `tools/`). */
  readonly configDir: string;
  readonly logger: Logger;
  /**
   * Names of enabled upstream servers. A custom tool whose namespace equals one
   * of these would collide in the flat exposed-name space, so it is skipped and
   * logged rather than double-exposed (SPECS design principle 4). The CLI guards
   * (`tool import`, `server add-*`) prevent creating such a pair; this is the
   * defense for a hand-edited config + manifest.
   */
  readonly enabledServerNames: ReadonlySet<string>;
  /**
   * Namespace separator from the active config. The exposed name a custom tool
   * is published under is recomputed as `namespace + separator + name` and
   * checked against the stored `exposedName`, so a hand-edited manifest cannot
   * set `exposedName` to an unrelated value (e.g. an upstream tool name) and
   * shadow that entry in the registry.
   */
  readonly separator: string;
  /** OS-level sandbox posture for custom-tool execution (P3-06). */
  readonly sandbox?: SandboxOptions;
  /** Test seam: read the manifest. Defaults to the real `readToolManifest`. */
  readonly readManifest?: (configDir: string) => Promise<ToolManifest[]>;
  /** Test seam: resolve a tool's schema. Defaults to the real `describeTool`. */
  readonly describe?: (
    manifest: ToolManifest,
    options: { configDir: string; logger?: Logger; sandbox?: SandboxOptions },
  ) => Promise<DescribeOutcome>;
  /** Test seam: execute a tool. Defaults to the real `runTool`. */
  readonly run?: (
    manifest: ToolManifest,
    args: unknown,
    options: { configDir: string; logger: Logger; signal?: AbortSignal; sandbox?: SandboxOptions },
  ) => Promise<RunOutcome>;
}

export interface CustomToolHost {
  /**
   * Reads enabled custom tools, resolves their schemas, and returns the registry
   * inputs. Eligible tools are described concurrently, and `onRegistered` is
   * invoked with the growing set each time one resolves — so a healthy tool is
   * published as soon as it is ready rather than waiting for an unrelated slow or
   * hanging tool. Never throws: a corrupt manifest, a namespace collision, or a
   * tool whose schema cannot be resolved is logged and skipped so one bad tool
   * can never block the gateway from serving the rest. The returned promise
   * resolves once every eligible tool has settled (registered or skipped).
   */
  load(onRegistered?: (inputs: readonly CustomToolInput[]) => void): Promise<CustomToolInput[]>;
  /** Executes custom tools resolved by the most recent `load()`. */
  readonly executor: CustomToolExecutor;
  /**
   * The manifest snapshot the most recent `load()` read, resolving as soon as
   * the manifest has been read (before any describe). The daemon identity is
   * derived from this exact snapshot so it matches the set of tools actually
   * loaded — a fresh re-read could otherwise observe a manifest edit that landed
   * during startup and publish an identity inconsistent with the loaded tools.
   */
  readonly manifestSnapshot: Promise<readonly ToolManifest[]>;
}

function toRouteResult(
  view: RegisteredToolView,
  manifest: ToolManifest,
  outcome: RunOutcome,
): RouteResult {
  if (outcome.outcome === 'ok') {
    // The handler returns arbitrary JS; validate it is a well-formed MCP
    // CallToolResult before forwarding, so a malformed return surfaces as a tool
    // error rather than emitting invalid protocol data to the client.
    const parsed = CallToolResultSchema.safeParse(outcome.result);
    if (!parsed.success) {
      return {
        kind: 'upstream_error',
        error: {
          code: 'upstream',
          server: view.serverName,
          tool: view.upstreamName,
          message: `custom tool "${view.exposedName}" returned a result that is not a valid CallToolResult`,
        },
      };
    }
    return { kind: 'ok', result: parsed.data as RoutedCallToolResult };
  }
  if (outcome.outcome === 'timeout') {
    return {
      kind: 'upstream_error',
      error: {
        code: 'timeout',
        server: view.serverName,
        tool: view.upstreamName,
        timeoutMs: manifest.timeoutMs,
        message: `Custom tool "${view.upstreamName}" in namespace "${view.serverName}" timed out after ${String(manifest.timeoutMs)}ms`,
      },
    };
  }
  if (outcome.code === 'invalid-args') {
    return { kind: 'invalid_args', issues: [{ path: [], message: outcome.message }] };
  }
  return {
    kind: 'upstream_error',
    error: {
      code: 'upstream',
      server: view.serverName,
      tool: view.upstreamName,
      message: outcome.message,
    },
  };
}

export function createCustomToolHost(deps: CustomToolHostDeps): CustomToolHost {
  const log = deps.logger.child({ component: 'custom-tools' });
  const readManifest = deps.readManifest ?? defaultReadToolManifest;
  const describe = deps.describe ?? ((m, o) => defaultDescribeTool(m, o));
  const run = deps.run ?? ((m, args, o) => defaultRunTool(m, args, o));

  // Populated by `load()`; the executor reads it. Keyed by exposed name.
  const manifests = new Map<string, ToolManifest>();

  // Resolves with the exact manifest snapshot `load()` read (or `[]` on a read
  // failure), so the daemon identity can be derived from the same snapshot.
  let resolveSnapshot!: (entries: readonly ToolManifest[]) => void;
  const manifestSnapshot = new Promise<readonly ToolManifest[]>((resolve) => {
    resolveSnapshot = resolve;
  });

  /** Returns true if `entry` is an eligible custom tool to describe; logs + skips otherwise. */
  function isEligible(entry: ToolManifest): boolean {
    if (!entry.enabled) {
      return false;
    }
    if (deps.enabledServerNames.has(entry.namespace)) {
      log.warn(
        { tool: entry.exposedName, namespace: entry.namespace },
        'custom tool namespace collides with an enabled server; skipping',
      );
      return false;
    }
    // The `toolbox` namespace is reserved for ToolBox's own bootstrap tools
    // (`toolbox__search_tools`, …). A custom tool under it would be shadowed by
    // the bootstrap dispatch in `tools/call` and filtered from `tools/list`,
    // i.e. unreachable, so skip it rather than publish an uncallable entry.
    if (entry.namespace === RESERVED_NAMESPACE) {
      log.warn(
        { tool: entry.exposedName },
        'custom tool uses the reserved "toolbox" namespace; skipping',
      );
      return false;
    }
    // The exposed name must be exactly namespace + separator + name. A manifest
    // edited to claim a different exposedName (e.g. an upstream tool's name)
    // would otherwise be published under that key and shadow the real entry in
    // `registry.find()`.
    const canonicalExposedName = `${entry.namespace}${deps.separator}${entry.name}`;
    if (entry.exposedName !== canonicalExposedName) {
      log.warn(
        { tool: entry.exposedName, expected: canonicalExposedName },
        'custom tool exposedName does not match its namespace/name; skipping',
      );
      return false;
    }
    // Pin the entry to its canonical `tools/<namespace>/<name>.<ext>` path — the
    // same guard enable/remove/inspect apply — so a hand-edited manifest cannot
    // point an enabled tool at a file outside the tools tree for the describe or
    // execution path to act on.
    try {
      resolveToolEntryPath(deps.configDir, entry);
    } catch (error) {
      if (error instanceof ToolManifestError) {
        log.warn(
          { tool: entry.exposedName, err: error },
          'custom tool entry path is not canonical; skipping',
        );
        return false;
      }
      throw error;
    }
    return true;
  }

  /** Resolves one eligible tool's schema, returning its registry input or `undefined`. */
  async function describeEligible(entry: ToolManifest): Promise<CustomToolInput | undefined> {
    let outcome: DescribeOutcome;
    try {
      outcome = await describe(entry, {
        configDir: deps.configDir,
        logger: log,
        ...(deps.sandbox !== undefined ? { sandbox: deps.sandbox } : {}),
      });
    } catch (error) {
      log.warn({ err: error, tool: entry.exposedName }, 'failed to describe custom tool; skipping');
      return undefined;
    }
    if (outcome.outcome !== 'ok') {
      log.warn(
        {
          tool: entry.exposedName,
          ...(outcome.outcome === 'error' ? { code: outcome.code } : { outcome: outcome.outcome }),
        },
        'could not resolve custom tool schema; skipping',
      );
      return undefined;
    }
    const tool: Tool = {
      name: entry.exposedName,
      title: entry.title,
      description: entry.description,
      inputSchema: outcome.inputSchema as Tool['inputSchema'],
      _meta: { [CUSTOM_TOOL_META_KEY]: true },
    };
    return { exposedName: entry.exposedName, namespace: entry.namespace, name: entry.name, tool };
  }

  async function load(
    onRegistered?: (inputs: readonly CustomToolInput[]) => void,
  ): Promise<CustomToolInput[]> {
    manifests.clear();
    let entries: ToolManifest[];
    try {
      entries = await readManifest(deps.configDir);
    } catch (error) {
      log.warn({ err: error }, 'failed to read custom tool manifest; skipping custom tools');
      resolveSnapshot([]);
      return [];
    }
    // Publish the snapshot before describing so the daemon identity (which awaits
    // it) reflects exactly the manifest these tools are loaded from — including a
    // digest of each enabled tool's source, so re-importing edited source (even
    // with unchanged metadata) invalidates a reused daemon.
    resolveSnapshot(await digestToolSources(deps.configDir, entries));

    const eligible = entries.filter((entry) => isEligible(entry));
    // Describe concurrently — each tool runs in its own timeout-bounded child —
    // and register each success as it lands, so a healthy tool is published right
    // away instead of waiting for an unrelated slow/hanging describe to settle.
    // The per-describe continuations run as microtasks, so appending to `inputs`
    // and calling `onRegistered` need no further synchronization.
    const inputs: CustomToolInput[] = [];
    await Promise.all(
      eligible.map(async (entry) => {
        const input = await describeEligible(entry);
        if (input !== undefined) {
          manifests.set(input.exposedName, entry);
          inputs.push(input);
          onRegistered?.([...inputs]);
        }
      }),
    );
    return inputs;
  }

  const executor: CustomToolExecutor = {
    async run(view, args, signal) {
      const manifest = manifests.get(view.exposedName);
      if (manifest === undefined) {
        return { kind: 'unknown_tool' };
      }
      const outcome = await run(manifest, args, {
        configDir: deps.configDir,
        logger: log,
        ...(signal !== undefined ? { signal } : {}),
        ...(deps.sandbox !== undefined ? { sandbox: deps.sandbox } : {}),
      });
      return toRouteResult(view, manifest, outcome);
    },
  };

  return { load, executor, manifestSnapshot };
}
