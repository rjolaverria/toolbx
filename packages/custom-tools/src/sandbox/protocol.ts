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
  | 'tool-error';

/** Child → parent: result of attempting to load the tool module. */
export type SandboxLoadMessage =
  | { readonly phase: 'loaded'; readonly inputSchema: unknown; readonly hasHandler: boolean }
  | { readonly phase: 'load-error'; readonly message: string };

/** Child → parent: result of invoking the handler (sent only after an 'invoke' command). */
export type SandboxResultMessage =
  | { readonly phase: 'result'; readonly ok: true; readonly result: unknown }
  | { readonly phase: 'result'; readonly ok: false; readonly message: string };

/** Any message the child can send. */
export type SandboxMessage = SandboxLoadMessage | SandboxResultMessage;

/** Parent → child: validation passed; run the handler. */
export interface SandboxInvokeCommand {
  readonly phase: 'invoke';
}

/** Final outcome `runTool` resolves to. `message` is already secret-redacted. */
export type RunOutcome =
  | { readonly outcome: 'ok'; readonly result: unknown }
  | { readonly outcome: 'timeout' }
  | { readonly outcome: 'error'; readonly code: RunErrorCode; readonly message: string };
