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
