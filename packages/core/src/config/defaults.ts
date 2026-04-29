import type { ToolboxConfig } from './schema.js';

export const DEFAULT_NAMESPACE_SEPARATOR = '__';

export const CONFIG_SCHEMA_URL = 'https://toolbox.dev/schema/config.schema.json';

export const DEFAULT_CONFIG: ToolboxConfig = Object.freeze({
  $schema: CONFIG_SCHEMA_URL,
  version: 1,
  server: Object.freeze({
    stdio: Object.freeze({ enabled: true }),
    http: Object.freeze({
      enabled: true,
      host: '127.0.0.1',
      port: 7331,
      path: '/mcp',
    }),
  }),
  progressiveDisclosure: Object.freeze({
    enabled: true,
    mode: 'session',
    bootstrapTools: true,
    autoRevealExactServerMatches: true,
    maxSearchResults: 20,
  }),
  namespacing: Object.freeze({
    separator: DEFAULT_NAMESPACE_SEPARATOR,
    format: 'server__tool',
    collisionStrategy: 'error',
  }),
  servers: Object.freeze({}),
});
