export {
  parseToolMetadata,
  analyzeToolImports,
  ToolMetadataParseError,
  type ParsedToolMetadata,
  type ToolImportAnalysis,
  type ParseIssue,
  type ParseWarning,
} from './manifest/parse.js';

export {
  importTool,
  planImport,
  commitImport,
  ToolImportError,
  type CommitImportOptions,
  type ImportToolOptions,
  type ImportedTool,
  type ImportPlan,
  type ToolImportErrorCode,
  type ToolManifest,
  type ToolPermissions,
} from './manifest/import.js';

export {
  readToolManifest,
  writeToolManifest,
  findToolByExposedName,
  setToolEnabled,
  removeTool,
  resolveToolEntryPath,
  digestToolSources,
  toolsDirPath,
  toolsManifestPath,
  ToolManifestError,
  type ToolManifestErrorCode,
  type SetEnabledResult,
  type RemoveToolResult,
  type ToolManifestWithDigest,
} from './manifest/store.js';

export { runTool, describeTool, type RunToolOptions } from './sandbox/runner.js';
export {
  type RunOutcome,
  type DescribeOutcome,
  type RunErrorCode,
  type SandboxRequest,
  type SandboxResponse,
  type SandboxEnvelope,
} from './sandbox/protocol.js';
export { redactSecrets } from './sandbox/redact.js';
export {
  wrapSpawn,
  SandboxUnavailableError,
  type SandboxOptions,
  type PlatformProbe,
  type WrapSpawnResult,
} from './sandbox/os-sandbox.js';
