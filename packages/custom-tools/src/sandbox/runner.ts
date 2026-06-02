/**
 * Custom tool runtime (P3-03). Runs one imported tool per call in an isolated Node
 * child process, enforcing the per-tool timeout, the network/env permission model, and
 * JSON-Schema arg validation, then emits a single secret-redacted audit entry. A child
 * process (not a worker thread) keeps the boundary wrappable by an OS sandbox later.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNoopLogger, type Logger } from '@toolbox/core';

import type { ToolManifest } from '../manifest/import.js';
import { redactSecrets } from './redact.js';
import type { RunOutcome, SandboxRequest, SandboxResponse } from './protocol.js';

export interface RunToolOptions {
  /** Logger for the audit entry. Defaults to a no-op logger. */
  readonly logger?: Logger;
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
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
      secretValues.push(value);
    }
  }
  return { env, secretValues };
}

export async function runTool(
  manifest: ToolManifest,
  args: unknown,
  options: RunToolOptions = {},
): Promise<RunOutcome> {
  const logger = options.logger ?? createNoopLogger();
  const { env, secretValues } = buildEnv(manifest.permissions.env);
  const start = Date.now();

  const outcome = await new Promise<RunOutcome>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', harnessPath()],
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
      entry: manifest.entry,
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
