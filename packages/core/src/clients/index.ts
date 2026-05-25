export { claudeAdapter, createClaudeAdapter } from './claude.js';
export type { CreateClaudeAdapterOptions } from './claude.js';
export { codexAdapter, createCodexAdapter } from './codex.js';
export type { CreateCodexAdapterOptions } from './codex.js';
export { opencodeAdapter, createOpencodeAdapter } from './opencode.js';
export type { CreateOpencodeAdapterOptions } from './opencode.js';
export { detectClients } from './detect.js';
export {
  TOOLBOX_NPX_COMMAND,
  TOOLBOX_NPX_PACKAGE,
  TOOLBOX_STDIO_ARGS,
  TOOLBOX_STDIO_COMMAND,
} from './toolbox-command.js';
export type {
  ClientAdapter,
  ClientAdapterEnv,
  ClientName,
  DetectedClient,
  InstallOpts,
  InstallResult,
} from './types.js';
