import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  CustomToolExecutor,
  Logger,
  RegisteredToolView,
  RouteResult,
  RoutedCallToolResult,
} from '@toolbox/core';
import {
  describeTool as defaultDescribeTool,
  readToolManifest as defaultReadToolManifest,
  runTool as defaultRunTool,
  type DescribeOutcome,
  type RunOutcome,
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
  /** Test seam: read the manifest. Defaults to the real `readToolManifest`. */
  readonly readManifest?: (configDir: string) => Promise<ToolManifest[]>;
  /** Test seam: resolve a tool's schema. Defaults to the real `describeTool`. */
  readonly describe?: (
    manifest: ToolManifest,
    options: { configDir: string },
  ) => Promise<DescribeOutcome>;
  /** Test seam: execute a tool. Defaults to the real `runTool`. */
  readonly run?: (
    manifest: ToolManifest,
    args: unknown,
    options: { configDir: string; logger: Logger },
  ) => Promise<RunOutcome>;
}

export interface CustomToolHost {
  /**
   * Reads enabled custom tools, resolves their schemas, and returns the registry
   * inputs to publish. Never throws: a corrupt manifest, a namespace collision,
   * or a tool whose schema cannot be resolved is logged and skipped so one bad
   * tool can never block the gateway from serving the rest.
   */
  load(): Promise<CustomToolInput[]>;
  /** Executes custom tools resolved by the most recent `load()`. */
  readonly executor: CustomToolExecutor;
}

function toRouteResult(
  view: RegisteredToolView,
  manifest: ToolManifest,
  outcome: RunOutcome,
): RouteResult {
  if (outcome.outcome === 'ok') {
    return { kind: 'ok', result: outcome.result as RoutedCallToolResult };
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

  async function load(): Promise<CustomToolInput[]> {
    manifests.clear();
    let entries: ToolManifest[];
    try {
      entries = await readManifest(deps.configDir);
    } catch (error) {
      log.warn({ err: error }, 'failed to read custom tool manifest; skipping custom tools');
      return [];
    }

    const inputs: CustomToolInput[] = [];
    for (const entry of entries) {
      if (!entry.enabled) {
        continue;
      }
      if (deps.enabledServerNames.has(entry.namespace)) {
        log.warn(
          { tool: entry.exposedName, namespace: entry.namespace },
          'custom tool namespace collides with an enabled server; skipping',
        );
        continue;
      }
      let outcome: DescribeOutcome;
      try {
        outcome = await describe(entry, { configDir: deps.configDir });
      } catch (error) {
        log.warn(
          { err: error, tool: entry.exposedName },
          'failed to describe custom tool; skipping',
        );
        continue;
      }
      if (outcome.outcome !== 'ok') {
        log.warn(
          {
            tool: entry.exposedName,
            ...(outcome.outcome === 'error'
              ? { code: outcome.code }
              : { outcome: outcome.outcome }),
          },
          'could not resolve custom tool schema; skipping',
        );
        continue;
      }
      const tool: Tool = {
        name: entry.exposedName,
        title: entry.title,
        description: entry.description,
        inputSchema: outcome.inputSchema as Tool['inputSchema'],
        _meta: { [CUSTOM_TOOL_META_KEY]: true },
      };
      manifests.set(entry.exposedName, entry);
      inputs.push({
        exposedName: entry.exposedName,
        namespace: entry.namespace,
        name: entry.name,
        tool,
      });
    }
    return inputs;
  }

  const executor: CustomToolExecutor = {
    async run(view, args) {
      const manifest = manifests.get(view.exposedName);
      if (manifest === undefined) {
        return { kind: 'unknown_tool' };
      }
      const outcome = await run(manifest, args, { configDir: deps.configDir, logger: log });
      return toRouteResult(view, manifest, outcome);
    },
  };

  return { load, executor };
}
