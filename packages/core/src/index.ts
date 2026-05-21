export { getToolBoxVersion } from './version.js';

export {
  AuthSchema,
  BearerAuthSchema,
  HttpServerConfigSchema,
  HttpServerSettingsSchema,
  LOOPBACK_HOSTS,
  LoopbackHostSchema,
  NamespacingSchema,
  NoneAuthSchema,
  OAuthAuthSchema,
  ProgressiveDisclosureSchema,
  ServerConfigSchema,
  ServerNameSchema,
  ServerSettingsSchema,
  ServersMapSchema,
  StdioServerConfigSchema,
  StdioServerSettingsSchema,
  TokenStorageSchema,
  ToolBoxConfigSchema,
  ToolOverrideSchema,
  ToolOverridesMapSchema,
  TopLevelAuthSchema,
  type AuthConfig,
  type HttpServerConfig,
  type NamespacingConfig,
  type ProgressiveDisclosureConfig,
  type ServerConfig,
  type ServerSettings,
  type StdioServerConfig,
  type TokenStorage,
  type ToolBoxConfig,
  type ToolBoxConfigInput,
  type ToolOverride,
  type TopLevelAuth,
} from './config/schema.js';

export {
  describeConfigPath,
  getDefaultConfigPath,
  resolveConfigPath,
  type ConfigPathEnv,
  type ConfigPathSource,
  type ResolvedConfigPath,
} from './config/paths.js';

export { ConfigLoadError, ConfigValidationError, loadConfig, parseConfig } from './config/load.js';

export {
  DuplicateKeyError,
  findDuplicateKeys,
  type DuplicateKey,
} from './config/duplicate-keys.js';

export { saveConfig } from './config/save.js';

export {
  CONFIG_SCHEMA_URL,
  DEFAULT_CONFIG,
  DEFAULT_NAMESPACE_SEPARATOR,
} from './config/defaults.js';

export {
  createLogger,
  createNoopLogger,
  type CreateLoggerOptions,
  type LogBindings,
  type LogDestination,
  type LogFormat,
  type LogLevel,
  type LogLevelWithSilent,
  type Logger,
} from './logging/logger.js';

export type { ServerStatus, ServerStatusKind } from './server-status/types.js';

export {
  assertValidTransition,
  InvalidStatusTransitionError,
  isValidTransition,
  transition,
  type ServerStatusEvent,
  type ServerStatusEventType,
} from './server-status/state-machine.js';

export {
  detectCollisions,
  formatExposedName,
  parseExposedName,
  UnsupportedNamespacingOptionError,
  type NamespaceCollision,
  type NamespaceOptions,
  type ParsedExposedName,
} from './namespace/index.js';

export {
  createStatusRegistry,
  UnknownServerError,
  type AuthStatus,
  type CreateStatusRegistryOptions,
  type LogLine,
  type ServerLogLevel,
  type ServerStatusEntry,
  type StatusRegistry,
  type StatusRegistryListener,
  type StatusRegistryUpdate,
} from './server-status/registry.js';

export {
  routeToolCall,
  type RegisteredToolView,
  type RegistryView,
  type RoutedCallToolResult,
  type RouteIssue,
  type RouteResult,
  type RouteToolCallParams,
  type RouteUpstreamError,
  type SessionCallToolOptions,
  type SessionLookup,
  type SessionView,
} from './proxy/index.js';

export {
  createSessionVisibility,
  searchTools,
  type SearchMatchedField,
  type SessionVisibility,
  type SessionVisibilityChangeListener,
  type SessionVisibilityChangeReason,
  type SessionVisibilityOptions,
  type ToolSearchOptions,
  type ToolSearchResult,
  type VisibilityMode,
} from './disclosure/index.js';

export {
  readToolCache,
  resolveToolCachePath,
  ToolCacheError,
  ToolCacheFileSchema,
  ToolCacheMissingError,
  writeToolCache,
  type CachedTool,
  type ToolCacheFile,
  type WriteToolCacheInput,
} from './tool-cache/index.js';

export {
  clearServeState,
  isProcessAlive,
  readServeState,
  resolveServeDaemonPaths,
  ServeDaemonStateSchema,
  serveDaemonPathsForConfig,
  writeServeState,
  type ServeDaemonPaths,
  type ServeDaemonState,
} from './serve-daemon/index.js';

export {
  claudeAdapter,
  codexAdapter,
  createClaudeAdapter,
  createCodexAdapter,
  createOpencodeAdapter,
  detectClients,
  opencodeAdapter,
  type ClientAdapter,
  type ClientAdapterEnv,
  type ClientName,
  type CreateClaudeAdapterOptions,
  type CreateCodexAdapterOptions,
  type CreateOpencodeAdapterOptions,
  type DetectedClient,
  type InstallOpts,
  type InstallResult,
} from './clients/index.js';

export {
  createTokenStore,
  InMemoryTokenStore,
  probeUpstreamAuth,
  runOAuthLogin,
  type AuthHint,
  type CreateTokenStoreDeps,
  type ProbeUpstreamAuthDeps,
  type RunOAuthLoginInput,
  type RunOAuthLoginResult,
  type StoredOAuthRecord,
  type TokenStore,
  type TokenStoreHealth,
} from './auth/index.js';
