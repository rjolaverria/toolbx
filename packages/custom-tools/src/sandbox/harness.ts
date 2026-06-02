/**
 * Custom tool child-process harness (P3-03). Runs in a Node child process spawned by
 * the runner. Seals Node runtime escape hatches (process.getBuiltinModule, binding, etc.),
 * applies the network permission gate, loads the pure tool, validates its `inputSchema`
 * and the call `args` with Ajv, invokes the handler, and reports the outcome over IPC.
 *
 * The `env` permission is enforced by the parent (the child is spawned with only
 * allowlisted vars), so it needs no handling here.
 *
 * The permission model is best-effort in-process hardening. The deferred OS-level sandbox
 * (srt) is the real isolation boundary; sealing escape hatches here makes the in-process
 * model meaningful while that stronger sandbox is not yet in place.
 */

import { pathToFileURL } from 'node:url';

import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';

import type { RunErrorCode, SandboxRequest, SandboxResponse } from './protocol.js';

/**
 * Sends one response and resolves only once it has flushed. `process.send` is
 * asynchronous, so the caller must await this before letting the process exit —
 * otherwise `process.exit` can drop the message before the parent receives it.
 */
function send(response: SandboxResponse): Promise<void> {
  return new Promise((resolve) => {
    if (process.send === undefined) {
      resolve();
      return;
    }
    process.send(response, () => {
      resolve();
    });
  });
}

function fail(code: RunErrorCode, message: string): Promise<void> {
  return send({ ok: false, code, message });
}

/**
 * Neutralizes Node escape hatches a pure tool never legitimately needs, so the
 * network/filesystem permission gates cannot be bypassed by pulling a builtin module
 * at runtime (e.g. `process.getBuiltinModule('node:fs')`). This is best-effort
 * in-process hardening, not a true sandbox: a hand-edited tool could still use a
 * runtime dynamic `import()` (rejected at import time, so stored tools never have one).
 * The deferred OS-level sandbox (srt) is the real boundary.
 */
function sealEscapeHatches(): void {
  const blocked = (name: string) => (): never => {
    throw new Error(`${name} is disabled for custom tools`);
  };
  const proc = process as unknown as Record<string, unknown>;
  for (const key of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen']) {
    if (typeof proc[key] === 'function') {
      proc[key] = blocked(`process.${key}`);
    }
  }
}

/** Replaces network globals with throwing stubs when `network` is denied. */
function applyNetworkGate(networkAllowed: boolean): void {
  if (networkAllowed) {
    return;
  }
  const blocked = (): never => {
    throw new Error('network access is disabled for this tool (permissions.network=false)');
  };
  Object.defineProperty(globalThis, 'fetch', { value: blocked, configurable: true });
  Object.defineProperty(globalThis, 'WebSocket', { value: blocked, configurable: true });
}

async function run(request: SandboxRequest): Promise<void> {
  sealEscapeHatches();
  applyNetworkGate(request.permissions.network);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(request.entry).href)) as Record<string, unknown>;
  } catch (error) {
    await fail('load-error', error instanceof Error ? error.message : String(error));
    return;
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(mod.inputSchema as object);
  } catch (error) {
    await fail('invalid-schema', error instanceof Error ? error.message : String(error));
    return;
  }

  const handler = mod.default;
  if (typeof handler !== 'function') {
    await fail('invalid-handler', 'tool default export is not a function');
    return;
  }

  if (!validate(request.args)) {
    const detail = ajv.errorsText(validate.errors, { separator: '; ' });
    await fail('invalid-args', `arguments do not match inputSchema: ${detail}`);
    return;
  }

  try {
    const result = await (handler as (input: unknown) => unknown)(request.args);
    await send({ ok: true, result });
  } catch (error) {
    await fail('tool-error', error instanceof Error ? error.message : String(error));
  }
}

// Keep the IPC channel referenced so the event loop stays alive for the duration of the
// tool call — without this, a tool that returns a never-resolving promise causes Node.js
// to exit once no other handles remain active (process.once consumes the listener, leaving
// the channel unreferenced).
process.channel?.ref();

process.once('message', (message: SandboxRequest) => {
  void run(message).finally(() => {
    process.exit(0);
  });
});
