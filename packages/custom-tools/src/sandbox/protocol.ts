import type { ToolPermissions } from '../manifest/import.js';

/** Request the runner sends to the child harness over IPC. */
export interface SandboxRequest {
  /** Absolute path to the tool entry file to load. */
  readonly entry: string;
  readonly permissions: ToolPermissions;
  /**
   * The allowlisted tool environment as name→value pairs. Delivered over IPC
   * (not the spawn environment) so the values never reach the outer sandbox
   * wrapper shell, where a shell-control var such as `BASH_ENV` could run code
   * before the OS sandbox starts. The harness applies it as the child's full
   * `process.env` after the sandbox boundary is active.
   */
  readonly env: Record<string, string>;
  /** Arguments to validate against `inputSchema` and pass to the handler. */
  readonly args: unknown;
  /**
   * Unguessable per-call nonce. The harness echoes it in every response; the parent
   * ignores any child message whose nonce does not match, so a tool that forges an IPC
   * message (via any process internal) cannot spoof a result — it never sees the nonce.
   */
  readonly nonce: string;
  /**
   * Describe-only mode: the harness loads the module, validates that `inputSchema`
   * is an object, and returns it in `result` without invoking the handler. Used by
   * the gateway to read a custom tool's schema for `tools/list` (P3-05). Absent /
   * false means a normal call.
   */
  readonly describe?: boolean;
}

/** Error codes the runtime can report for a single call. */
export type RunErrorCode =
  | 'invalid-schema'
  | 'invalid-handler'
  | 'invalid-args'
  | 'load-error'
  | 'forbidden-import'
  | 'tool-error'
  | 'sandbox-unavailable';

/** Response the child harness sends back over IPC. */
export type SandboxResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: RunErrorCode; readonly message: string };

/** Child → parent IPC message: a response authenticated with the per-call nonce. */
export type SandboxEnvelope = SandboxResponse & { readonly nonce: string };

/** Final outcome `runTool` resolves to. `message` is already secret-redacted. */
export type RunOutcome =
  | { readonly outcome: 'ok'; readonly result: unknown }
  | { readonly outcome: 'timeout' }
  | { readonly outcome: 'error'; readonly code: RunErrorCode; readonly message: string };

/**
 * Final outcome `describeTool` resolves to. The `ok` variant carries the tool's
 * `inputSchema`; the failure variants mirror `RunOutcome`. `message` is already
 * secret-redacted.
 */
export type DescribeOutcome =
  | { readonly outcome: 'ok'; readonly inputSchema: unknown }
  | { readonly outcome: 'timeout' }
  | { readonly outcome: 'error'; readonly code: RunErrorCode; readonly message: string };
