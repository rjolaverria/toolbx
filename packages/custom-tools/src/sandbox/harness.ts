/**
 * Custom tool child-process harness (P3-03). Runs in a Node child process spawned by
 * the runner. Seals Node runtime escape hatches (process.getBuiltinModule, binding, etc.),
 * removes process.send from tool-visible scope (anti-spoof), applies the network permission
 * gate, re-validates tool purity from disk (so an edited file cannot sneak in a static
 * import), loads the tool module, validates the args against inputSchema using
 * @cfworker/json-schema (interpreter-based, no Function/eval codegen), invokes the handler,
 * and reports the outcome over IPC in a single response message.
 *
 * @cfworker/json-schema is codegen-free, so it runs safely under
 * --disallow-code-generation-from-strings. Because validation happens here, a
 * pathological schema cannot block the parent event loop — the parent can SIGKILL this
 * child when the timeout fires, and all error messages are redacted by the runner.
 *
 * The `env` permission is enforced by the parent (the child is spawned with only
 * allowlisted vars), so it needs no handling here.
 *
 * The permission model is best-effort in-process hardening. The deferred OS-level sandbox
 * (srt) is the real isolation boundary; sealing escape hatches here makes the in-process
 * model meaningful while that stronger sandbox is not yet in place.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Validator } from '@cfworker/json-schema';

import type { ToolImportAnalysis } from '../manifest/parse.js';
import type { RunErrorCode, SandboxEnvelope, SandboxRequest, SandboxResponse } from './protocol.js';

/**
 * Dynamically imports `analyzeToolImports` from parse, resolving the correct extension
 * (.ts in development/test, .js in production) by matching the harness's own extension.
 * A static import of `parse.js` would fail at test time when the harness runs as `.ts`
 * because Node's `--experimental-transform-types` does not auto-rewrite `.js` → `.ts`.
 */
async function loadAnalyzeToolImports(): Promise<
  (source: string, filename: string) => ToolImportAnalysis
> {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  const parseUrl = pathToFileURL(
    path.join(path.dirname(here), '..', 'manifest', `parse${ext}`),
  ).href;
  const mod = (await import(parseUrl)) as {
    analyzeToolImports: (s: string, f: string) => ToolImportAnalysis;
  };
  return mod.analyzeToolImports;
}

// Capture trusted IPC and exit references at module load, before any tool code can tamper
// with them. The harness uses these private references for all its own IPC/exit calls.
//
// We capture the low-level `process._send` (not `process.send`): the public `process.send`
// wrapper delegates to `this._send` at call time, so once `sealEscapeHatches` deletes
// `_send` from tool view the public wrapper would throw. Binding `_send` directly keeps the
// harness's own send path working after both senders are removed from the tool's reach.
// `_send(message, handle, options, callback)` is the documented internal signature.
type LowLevelSend = (
  message: unknown,
  handle: undefined,
  options: undefined,
  callback: () => void,
) => void;
const realSend = (process as unknown as { _send?: LowLevelSend })._send?.bind(process);
const realExit = process.exit.bind(process);

/**
 * Sends one response over the captured IPC reference, stamped with the per-call nonce, and
 * resolves only once it has flushed. The nonce authenticates the message to the parent: a
 * tool that forges an IPC message cannot supply it (the request is consumed by
 * `process.once('message')` before any tool code runs, and the nonce lives only in this
 * closure). Using the captured reference also means tool code that deletes or replaces
 * the IPC senders cannot suppress the response. The send is asynchronous — the caller must
 * await this before letting the process exit, otherwise `process.exit` can drop the message
 * before the parent receives it.
 */
function sendWithNonce(nonce: string, response: SandboxResponse): Promise<void> {
  return new Promise((resolve) => {
    if (realSend === undefined) {
      resolve();
      return;
    }
    const envelope: SandboxEnvelope = { ...response, nonce };
    realSend(envelope, undefined, undefined, () => {
      resolve();
    });
  });
}

/**
 * Neutralizes Node escape hatches and process-control APIs a pure tool never legitimately
 * needs, and removes the IPC sender so tool code cannot spoof a response. Best-effort
 * in-process hardening; the deferred OS sandbox (srt) is the real boundary.
 */
function sealEscapeHatches(): void {
  const blocked = (name: string) => (): never => {
    throw new Error(`${name} is disabled for custom tools`);
  };
  const proc = process as unknown as Record<string, unknown>;
  for (const key of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'kill', 'abort']) {
    if (typeof proc[key] === 'function') {
      proc[key] = blocked(`process.${key}`);
    }
  }
  // Remove IPC reach so tool code cannot spoof a result or tear down the channel. The
  // per-call nonce is the real defense (a forged message cannot carry it); deleting the
  // senders is belt-and-suspenders against the more obvious IPC paths.
  delete proc['send'];
  delete proc['_send'];
  if (typeof proc['disconnect'] === 'function') {
    proc['disconnect'] = blocked('process.disconnect');
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
  const nonce = request.nonce;
  const send = (response: SandboxResponse): Promise<void> => sendWithNonce(nonce, response);
  const fail = (code: RunErrorCode, message: string): Promise<void> =>
    send({ ok: false, code, message });

  sealEscapeHatches();
  applyNetworkGate(request.permissions.network);

  // Re-validate purity in the child before importing the mutable on-disk file. This runs
  // inside the timeout-killable child, so a pathological file cannot block the parent.
  let source: string;
  try {
    source = await fs.readFile(request.entry, 'utf8');
  } catch (error) {
    await fail('load-error', error instanceof Error ? error.message : String(error));
    return;
  }

  const analyzeToolImports = await loadAnalyzeToolImports();
  const analysis = analyzeToolImports(source, request.entry);
  if (analysis.syntaxErrors.length > 0) {
    await fail(
      'load-error',
      `stored tool has a syntax error: ${analysis.syntaxErrors[0]?.message ?? 'unknown'}`,
    );
    return;
  }

  const runtimeImports = [
    ...analysis.relativeImports,
    ...analysis.bareImports,
    ...analysis.dynamicImports.map((issue) =>
      issue.line !== undefined ? `dynamic import (line ${issue.line})` : 'dynamic import',
    ),
  ];
  if (runtimeImports.length > 0) {
    await fail(
      'forbidden-import',
      `stored tool contains forbidden runtime imports: ${runtimeImports.join(', ')}`,
    );
    return;
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(request.entry).href)) as Record<string, unknown>;
  } catch (error) {
    await fail('load-error', error instanceof Error ? error.message : String(error));
    return;
  }

  const schema = mod.inputSchema;
  if (typeof schema !== 'object' || schema === null) {
    await fail('invalid-schema', 'inputSchema must be a JSON Schema object');
    return;
  }

  let validator: Validator;
  try {
    validator = new Validator(schema);
  } catch (error) {
    await fail('invalid-schema', error instanceof Error ? error.message : String(error));
    return;
  }

  if (typeof mod.default !== 'function') {
    await fail('invalid-handler', 'tool default export is not a function');
    return;
  }

  const validation = validator.validate(request.args);
  if (!validation.valid) {
    const first = validation.errors[0];
    const detail = first === undefined ? '' : `${first.instanceLocation} ${first.error}`;
    await fail('invalid-args', `arguments do not match inputSchema: ${detail}`);
    return;
  }

  try {
    const handler = mod.default as (input: unknown) => unknown;
    const result = await handler(request.args);
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
    realExit(0);
  });
});
