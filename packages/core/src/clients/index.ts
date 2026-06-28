export { claudeAdapter, createClaudeAdapter } from './claude.js';
export type { CreateClaudeAdapterOptions } from './claude.js';
export { codexAdapter, createCodexAdapter } from './codex.js';
export type { CreateCodexAdapterOptions } from './codex.js';
export { opencodeAdapter, createOpencodeAdapter } from './opencode.js';
export type { CreateOpencodeAdapterOptions } from './opencode.js';
export { detectClients } from './detect.js';
export {
  TOOLBX_NPX_COMMAND,
  TOOLBX_NPX_PACKAGE,
  TOOLBX_STDIO_ARGS,
  TOOLBX_STDIO_COMMAND,
} from './toolbx-command.js';
export type {
  ClientAdapter,
  ClientAdapterEnv,
  ClientName,
  DetectedClient,
  InstallOpts,
  InstallResult,
} from './types.js';
