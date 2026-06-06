/**
 * Custom tool runtime (P3-03). Runs one imported tool per call in an isolated Node
 * child process, enforcing the per-tool timeout, the network/env permission model, and
 * JSON-Schema arg validation (inside the child via @cfworker/json-schema), then emits a
 * single secret-redacted audit entry. A child process (not a worker thread) keeps the
 * boundary wrappable by an OS sandbox later.
 *
 * The child runs under --disallow-code-generation-from-strings so that eval/Function-
 * based import bypasses (e.g. `Function('return import("node:fs")')()`) are blocked by
 * the engine. @cfworker/json-schema is interpreter-based (no codegen), so validation
 * can run safely inside the child — a pathological schema cannot block the parent event
 * loop because the parent can SIGKILL the child when the timeout fires.
 *
 * Purity revalidation (checking the on-disk tool file for forbidden imports) is performed
 * inside the child before the tool module is imported. Running it in the child means it
 * is covered by the parent's timeout SIGKILL, so a pathological file cannot block the
 * parent event loop.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNoopLogger, type Logger } from '@toolbox/core';

import type { ToolManifest } from '../manifest/import.js';
import {
  killProcessTree,
  SandboxUnavailableError,
  wrapSpawn,
  type PlatformProbe,
  type SandboxOptions,
  type WrapSpawnResult,
} from './os-sandbox.js';
import { redactSecrets } from './redact.js';
import type { DescribeOutcome, RunOutcome, SandboxEnvelope, SandboxRequest } from './protocol.js';

/**
 * Node runtime-control variables that must never reach the sandboxed child, even when a
 * tool allowlists them: they are honored by the child Node process before the harness
 * installs its gates (e.g. NODE_OPTIONS='--require evil.js' would run arbitrary code).
 * Stored uppercase so the comparison can be case-insensitive (Windows env names are
 * case-insensitive, so 'node_options' must also be blocked).
 */
const FORBIDDEN_CHILD_ENV = new Set(['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE']);

/**
 * Upper bound on a describe (schema-resolution) operation, independent of the
 * tool's per-call `timeoutMs`. Schema resolution only imports the (pure) module
 * and compiles the schema, so a valid tool finishes far inside this; the cap
 * exists so the gateway's startup readiness never waits out a long per-call
 * timeout for a tool that hangs at module top level (P3-05).
 */
const DESCRIBE_TIMEOUT_CAP_MS = 6000;

export interface RunToolOptions {
  /** Logger for the audit entry. Defaults to a no-op logger. */
  readonly logger?: Logger;
  /**
   * Absolute ToolBox config directory used to resolve a relative `manifest.entry`
   * (`tools/<namespace>/<name>.<ext>`). Required unless `manifest.entry` is already
   * absolute (e.g. test fixtures).
   */
  readonly configDir?: string;
  /**
   * Aborts the call: when it fires the child is SIGKILLed and the call resolves
   * to an error outcome, instead of running to the per-tool timeout. The gateway
   * forwards the downstream request's signal so a cancelled `tools/call` stops
   * the tool promptly.
   */
  readonly signal?: AbortSignal;
  /** OS-level sandbox posture (P3-06). Defaults to `{ mode: 'auto', require: false }`. */
  readonly sandbox?: SandboxOptions;
  /** Test seam: platform probe used by the OS sandbox. Defaults to the real srt probe. */
  readonly sandboxProbe?: PlatformProbe;
}

/** Resolves the harness file next to this module, matching its extension (.ts/.js). */
function harnessPath(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  return path.join(path.dirname(here), `harness${ext}`);
}

/** The env subset the child may see, plus the secret values to redact from logs. */
function buildEnv(allowlist: readonly string[]): {
  env: Record<string, string>;
  secretValues: string[];
} {
  const env: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const key of allowlist) {
    if (FORBIDDEN_CHILD_ENV.has(key.toUpperCase())) {
      continue;
    }
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
      secretValues.push(value);
    }
  }
  return { env, secretValues };
}

/**
 * Returns an absolute path for the tool entry.
 * If `entry` is already absolute (e.g. test fixtures) it is returned unchanged.
 * Otherwise `configDir` must be provided to resolve it relative to the config directory.
 */
function resolveEntry(entry: string, configDir: string | undefined): string {
  if (path.isAbsolute(entry)) {
    return entry;
  }
  if (configDir === undefined) {
    throw new Error(`runTool requires a configDir to resolve the relative tool entry "${entry}"`);
  }
  return path.join(configDir, entry);
}

/**
 * Spawns the sandbox child for one operation — a normal call or a describe — and
 * resolves the raw {@link RunOutcome}. Shared by {@link runTool} and
 * {@link describeTool}; the audit log lives in `runTool` so describe stays quiet.
 * Error messages are secret-redacted here using the allowlisted env values.
 */
async function executeSandbox(
  manifest: ToolManifest,
  args: unknown,
  options: RunToolOptions,
  describe: boolean,
): Promise<RunOutcome> {
  const { env, secretValues } = buildEnv(manifest.permissions.env);

  const absoluteEntry = resolveEntry(manifest.entry, options.configDir);

  // Per-call nonce that authenticates the child's response. Tool code never sees it (the
  // request is consumed by the harness's process.once('message') before the tool runs), so
  // a forged IPC message cannot carry the matching nonce and is ignored by the parent.
  const nonce = randomUUID();

  // The unsandboxed child argv. --disallow-code-generation-from-strings blocks
  // eval/Function-based import bypasses (e.g. `Function('return import("node:fs")')()`).
  // --experimental-transform-types is a superset of --experimental-strip-types that also
  // handles non-erasable TS constructs (enum, namespace) so a valid TS tool doesn't
  // import-OK then fail at call time. Requires Node >= 22.7.0.
  const baseArgv = [
    process.execPath,
    '--disallow-code-generation-from-strings',
    '--experimental-transform-types',
    '--no-warnings',
    harnessPath(),
  ];

  // A function (not an inline `=== true`) so TypeScript's control-flow analysis
  // does not narrow `aborted` to false for the catch below: the signal can flip
  // to aborted during the awaited `wrapSpawn`, which CFA cannot see.
  const isAborted = (): boolean => options.signal?.aborted === true;
  const abortedOutcome: RunOutcome = {
    outcome: 'error',
    code: 'tool-error',
    message: 'custom tool call aborted',
  };

  // Already cancelled before sandbox setup: resolve to the aborted outcome
  // without generating a sandbox profile (which can be non-trivial on Linux).
  if (isAborted()) {
    return abortedOutcome;
  }

  // Wrap the spawn with the OS sandbox (P3-06) when available. `wrapSpawn` may
  // throw SandboxUnavailableError when the config requires a sandbox that the
  // host cannot provide; surface that as an error outcome rather than running
  // unsandboxed. It may also reject if the signal aborts mid-wrap (the signal is
  // forwarded to srt, which can cancel its Linux ripgrep scan) — translate that
  // into the same aborted outcome the post-spawn path uses.
  let wrapped: WrapSpawnResult;
  try {
    wrapped = await wrapSpawn({
      argv: baseArgv,
      env,
      permissions: manifest.permissions,
      // Allow reading the tool's own directory and its parent: a stored `.js`
      // tool lives at `tools/<namespace>/<name>.js` and loads as ESM via the
      // `tools/package.json` ({"type":"module"}) marker one level up, which Node
      // reads during module resolution. Under a home config dir, denyRead(home)
      // would otherwise hide that marker and break `.js` tools.
      readRoots: [path.dirname(absoluteEntry), path.dirname(path.dirname(absoluteEntry))],
      logger: options.logger ?? createNoopLogger(),
      ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.sandboxProbe !== undefined ? { probe: options.sandboxProbe } : {}),
    });
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      return { outcome: 'error', code: 'sandbox-unavailable', message: error.message };
    }
    if (isAborted()) {
      return abortedOutcome;
    }
    throw error;
  }

  const [spawnCommand, ...spawnArgs] = wrapped.argv;
  if (spawnCommand === undefined) {
    // wrapSpawn already incremented srt's per-command state on Linux, so run its
    // cleanup before bailing even though no child was spawned.
    wrapped.cleanup();
    return { outcome: 'error', code: 'load-error', message: 'empty sandbox spawn argv' };
  }

  return new Promise<RunOutcome>((resolve) => {
    // Cancelled in the window after wrapSpawn but before spawning: don't spawn a
    // child, but still run the sandbox cleanup wrapSpawn's setup registered.
    if (options.signal?.aborted === true) {
      wrapped.cleanup();
      resolve(abortedOutcome);
      return;
    }

    // `detached` puts the child in its own process group so `killProcessTree`
    // can SIGKILL the whole group: after OS-sandbox wrapping the direct child is
    // the wrapper shell, and killing only its PID would orphan the Node harness.
    const child = spawn(spawnCommand, spawnArgs, {
      env: wrapped.env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      detached: true,
    });

    let settled = false;
    let detachAbort: (() => void) | undefined;

    // srt's per-command cleanup must run exactly once (it decrements the Linux
    // active-sandbox counter). Idempotent so neither a missed nor a duplicate
    // `exit` event can skip or double-run it.
    let cleanedUp = false;
    const cleanupOnce = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      wrapped.cleanup();
    };

    function finish(value: RunOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      detachAbort?.();
      child.removeAllListeners();
      child.on('error', () => {
        // Absorb a stray EPIPE from an in-flight send after we have already settled.
      });
      // Run the sandbox's per-command cleanup once the process has exited (srt
      // Linux decrements its active-sandbox counter and removes bwrap mount-point
      // files). Only a child that actually started can emit `exit`; for a failed
      // spawn (no PID) or an already-exited child, run cleanup immediately so a
      // never-firing `exit` cannot leak it.
      const running =
        child.pid !== undefined && child.exitCode === null && child.signalCode === null;
      if (running) {
        child.once('exit', cleanupOnce);
        killProcessTree(child);
      } else {
        cleanupOnce();
      }
      resolve(value);
    }

    // Describe (schema resolution at exposure) is bounded by a short cap, not the
    // tool's full call timeout: it only imports the module and compiles the schema,
    // which a valid pure tool does in well under a second. Capping it keeps the
    // gateway's startup readiness wait short and bounded even when a tool with a
    // large per-call timeout hangs at module top level (P3-05).
    const operationTimeoutMs = describe
      ? Math.min(manifest.timeoutMs, DESCRIBE_TIMEOUT_CAP_MS)
      : manifest.timeoutMs;
    const timer = setTimeout(() => {
      finish({ outcome: 'timeout' });
    }, operationTimeoutMs);

    // Caller abort mid-run (e.g. a cancelled downstream `tools/call`): kill the
    // child and resolve immediately rather than waiting out the per-tool timeout.
    // The already-aborted case is handled before the spawn above.
    const onAbort = (): void => {
      finish({ outcome: 'error', code: 'tool-error', message: 'custom tool call aborted' });
    };
    if (options.signal !== undefined) {
      const signal = options.signal;
      signal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => signal.removeEventListener('abort', onAbort);
      // Close the race between the pre-spawn `aborted` check and attaching the
      // listener: if the signal fired in that window the listener missed it, so
      // re-check now and abort immediately.
      if (signal.aborted) {
        onAbort();
      }
    }

    child.on('message', (message: SandboxEnvelope) => {
      if (message.nonce !== nonce) {
        // Forged or stale message (a tool cannot know the nonce) — ignore it.
        return;
      }
      if (message.ok) {
        finish({ outcome: 'ok', result: message.result });
      } else {
        finish({
          outcome: 'error',
          code: message.code,
          message: redactSecrets(message.message, secretValues),
        });
      }
    });

    child.on('error', (error) => {
      finish({ outcome: 'error', code: 'load-error', message: error.message });
    });

    child.on('close', () => {
      finish({
        outcome: 'error',
        code: 'load-error',
        message: 'tool process exited without producing a result',
      });
    });

    const request: SandboxRequest = {
      entry: absoluteEntry,
      permissions: manifest.permissions,
      // The allowlisted env travels in the IPC request, not the spawn env, so it
      // never reaches the OS-sandbox wrapper shell.
      env,
      args,
      nonce,
      ...(describe ? { describe: true } : {}),
    };
    child.send(request);
  });
}

export async function runTool(
  manifest: ToolManifest,
  args: unknown,
  options: RunToolOptions = {},
): Promise<RunOutcome> {
  const logger = options.logger ?? createNoopLogger();
  const start = Date.now();
  const outcome = await executeSandbox(manifest, args, options, false);
  const durationMs = Date.now() - start;
  if (outcome.outcome === 'error') {
    logger.warn(
      { tool: manifest.exposedName, durationMs, outcome: 'error', errorCode: outcome.code },
      'custom tool call failed',
    );
  } else {
    logger.info(
      { tool: manifest.exposedName, durationMs, outcome: outcome.outcome },
      'custom tool call',
    );
  }
  return outcome;
}

/**
 * Resolves a custom tool's `inputSchema` by loading its module in the sandbox
 * without invoking the handler (P3-05). The gateway calls this to advertise the
 * tool in `tools/list`. Shares the runner's spawn/timeout/redaction plumbing; the
 * `ok` outcome carries the schema, and failures mirror {@link runTool}.
 *
 * Reading `inputSchema` requires importing the module, so the tool's top-level
 * code runs here even though the handler is never invoked. This runs in the same
 * sandbox a call uses — sealed escape hatches, the network/env permission gate,
 * `--disallow-code-generation-from-strings`, and the per-tool timeout with
 * SIGKILL — so a top-level side effect is contained and a top-level hang resolves
 * to `timeout` rather than blocking the gateway. The gateway skips a tool whose
 * describe fails, so it is never exposed.
 */
export async function describeTool(
  manifest: ToolManifest,
  options: RunToolOptions = {},
): Promise<DescribeOutcome> {
  const outcome = await executeSandbox(manifest, undefined, options, true);
  if (outcome.outcome === 'ok') {
    return { outcome: 'ok', inputSchema: outcome.result };
  }
  return outcome;
}
