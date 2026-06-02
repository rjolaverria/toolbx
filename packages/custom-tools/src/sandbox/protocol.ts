import type { ToolPermissions } from '../manifest/import.js';

/** Request the runner sends to the child harness over IPC. */
export interface SandboxRequest {
  /** Absolute path to the tool entry file to load. */
  readonly entry: string;
  readonly permissions: ToolPermissions;
  /** Arguments to validate against `inputSchema` and pass to the handler. */
  readonly args: unknown;
}

/** Error codes the runtime can report for a single call. */
export type RunErrorCode =
  | 'invalid-schema'
  | 'invalid-handler'
  | 'invalid-args'
  | 'load-error'
  | 'forbidden-import'
  | 'tool-error';

/** Response the child harness sends back over IPC. */
export type SandboxResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: RunErrorCode; readonly message: string };

/** Final outcome `runTool` resolves to. `message` is already secret-redacted. */
export type RunOutcome =
  | { readonly outcome: 'ok'; readonly result: unknown }
  | { readonly outcome: 'timeout' }
  | { readonly outcome: 'error'; readonly code: RunErrorCode; readonly message: string };
