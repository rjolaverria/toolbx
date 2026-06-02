/**
 * Custom tool child-process harness (P3-03). Runs in a Node child process spawned by
 * the runner. Seals Node runtime escape hatches (process.getBuiltinModule, binding, etc.),
 * applies the network permission gate, loads the pure tool, reports the schema to the
 * parent, awaits an 'invoke' command, invokes the handler, and reports the outcome over
 * IPC.
 *
 * Ajv is intentionally absent from this harness: the child runs under
 * --disallow-code-generation-from-strings, which blocks eval/Function-based codegen
 * (including the bypass `Function('return import("node:fs")()')`), but Ajv compiles
 * validators via new Function. JSON-Schema validation is therefore performed in the
 * trusted parent process (runner.ts).
 *
 * The `env` permission is enforced by the parent (the child is spawned with only
 * allowlisted vars), so it needs no handling here.
 *
 * The permission model is best-effort in-process hardening. The deferred OS-level sandbox
 * (srt) is the real isolation boundary; sealing escape hatches here makes the in-process
 * model meaningful while that stronger sandbox is not yet in place.
 */

import { pathToFileURL } from 'node:url';

import type { SandboxInvokeCommand, SandboxMessage, SandboxRequest } from './protocol.js';

/**
 * Sends one message and resolves only once it has flushed. `process.send` is
 * asynchronous, so the caller must await this before letting the process exit —
 * otherwise `process.exit` can drop the message before the parent receives it.
 */
function send(message: SandboxMessage): Promise<void> {
  return new Promise((resolve) => {
    if (process.send === undefined) {
      resolve();
      return;
    }
    process.send(message, () => {
      resolve();
    });
  });
}

/**
 * Neutralizes Node escape hatches a pure tool never legitimately needs, so the
 * network/filesystem permission gates cannot be bypassed by pulling a builtin module
 * at runtime (e.g. `process.getBuiltinModule('node:fs')`). This is best-effort
 * in-process hardening, not a true sandbox: the child also runs under
 * --disallow-code-generation-from-strings which blocks eval/Function-based import bypasses.
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
    await send({
      phase: 'load-error',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(0);
    return;
  }

  await send({
    phase: 'loaded',
    inputSchema: mod.inputSchema,
    hasHandler: typeof mod.default === 'function',
  });

  // Wait for the parent's validation verdict. If validation fails, the parent kills the
  // child without sending 'invoke', so this listener simply never fires.
  process.once('message', (command: SandboxInvokeCommand) => {
    void (async () => {
      if (command.phase !== 'invoke') {
        process.exit(0);
        return;
      }
      try {
        const handler = mod.default as (input: unknown) => unknown;
        const result = await handler(request.args);
        await send({ phase: 'result', ok: true, result });
      } catch (error) {
        await send({
          phase: 'result',
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      process.exit(0);
    })();
  });
}

// Keep the IPC channel referenced so the event loop stays alive for the duration of the
// tool call — without this, a tool that returns a never-resolving promise causes Node.js
// to exit once no other handles remain active (process.once consumes the listener, leaving
// the channel unreferenced).
process.channel?.ref();

process.once('message', (message: SandboxRequest) => {
  void run(message);
});
