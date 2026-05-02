export { getToolboxVersion } from './version.js';

export {
  AuthSchema,
  BearerAuthSchema,
  HttpServerConfigSchema,
  HttpServerSettingsSchema,
  NamespacingSchema,
  NoneAuthSchema,
  ProgressiveDisclosureSchema,
  ServerConfigSchema,
  ServerSettingsSchema,
  ServersMapSchema,
  StdioServerConfigSchema,
  StdioServerSettingsSchema,
  ToolboxConfigSchema,
  type AuthConfig,
  type HttpServerConfig,
  type NamespacingConfig,
  type ProgressiveDisclosureConfig,
  type ServerConfig,
  type ServerSettings,
  type StdioServerConfig,
  type ToolboxConfig,
  type ToolboxConfigInput,
} from './config/schema.js';

export { getDefaultConfigPath, resolveConfigPath, type ConfigPathEnv } from './config/paths.js';

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
  searchTools,
  type SearchMatchedField,
  type ToolSearchOptions,
  type ToolSearchResult,
} from './disclosure/index.js';

export {
  createSessionVisibility,
  type SessionVisibility,
  type SessionVisibilityChangeListener,
  type SessionVisibilityChangeReason,
  type SessionVisibilityOptions,
  type VisibilityMode,
} from './disclosure/index.js';
