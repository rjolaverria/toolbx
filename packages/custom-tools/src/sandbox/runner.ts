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
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNoopLogger, type Logger } from '@toolbox/core';

import type { ToolManifest } from '../manifest/import.js';
import { redactSecrets } from './redact.js';
import type { RunOutcome, SandboxRequest, SandboxResponse } from './protocol.js';

/**
 * Node runtime-control variables that must never reach the sandboxed child, even when a
 * tool allowlists them: they are honored by the child Node process before the harness
 * installs its gates (e.g. NODE_OPTIONS='--require evil.js' would run arbitrary code).
 * Stored uppercase so the comparison can be case-insensitive (Windows env names are
 * case-insensitive, so 'node_options' must also be blocked).
 */
const FORBIDDEN_CHILD_ENV = new Set(['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE']);

export interface RunToolOptions {
  /** Logger for the audit entry. Defaults to a no-op logger. */
  readonly logger?: Logger;
  /**
   * Absolute ToolBox config directory used to resolve a relative `manifest.entry`
   * (`tools/<namespace>/<name>.<ext>`). Required unless `manifest.entry` is already
   * absolute (e.g. test fixtures).
   */
  readonly configDir?: string;
}

/** Resolves the harness file next to this module, matching its extension (.ts/.js). */
function harnessPath(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  return path.join(path.dirname(here), `harness${ext}`);
}

/** The env subset the child may see, plus the secret values to redact from logs. */
function buildEnv(allowlist: readonly string[]): {
  env: NodeJS.ProcessEnv;
  secretValues: string[];
} {
  const env: NodeJS.ProcessEnv = {};
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

export async function runTool(
  manifest: ToolManifest,
  args: unknown,
  options: RunToolOptions = {},
): Promise<RunOutcome> {
  const logger = options.logger ?? createNoopLogger();
  const { env, secretValues } = buildEnv(manifest.permissions.env);
  const start = Date.now();

  const absoluteEntry = resolveEntry(manifest.entry, options.configDir);

  const outcome = await new Promise<RunOutcome>((resolve) => {
    const child = spawn(
      process.execPath,
      // --disallow-code-generation-from-strings blocks eval/Function-based import bypasses
      // (e.g. `Function('return import("node:fs")')()`) in the sandboxed child.
      // --experimental-transform-types is a superset of --experimental-strip-types and
      // also handles non-erasable TS constructs (enum, namespace) so a valid TS tool
      // doesn't import-OK then fail at call time. Requires Node >= 22.7.0.
      [
        '--disallow-code-generation-from-strings',
        '--experimental-transform-types',
        '--no-warnings',
        harnessPath(),
      ],
      { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );

    let settled = false;

    function finish(value: RunOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.on('error', () => {
        // Absorb a stray EPIPE from an in-flight send after we have already settled.
      });
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      resolve(value);
    }

    const timer = setTimeout(() => {
      finish({ outcome: 'timeout' });
    }, manifest.timeoutMs);

    child.on('message', (message: SandboxResponse) => {
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
      args,
    };
    child.send(request);
  });

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
