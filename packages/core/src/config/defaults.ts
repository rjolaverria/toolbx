import type { ToolbxConfig } from './schema.js';

export const DEFAULT_NAMESPACE_SEPARATOR = '__';

export const CONFIG_SCHEMA_URL = 'https://toolbx.dev/schema/config.schema.json';

export const DEFAULT_CONFIG: ToolbxConfig = Object.freeze({
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
  auth: Object.freeze({
    storage: Object.freeze({ type: 'keychain' }),
  }),
  servers: Object.freeze({}),
  tools: Object.freeze({}),
  customTools: Object.freeze({
    sandbox: Object.freeze({ mode: 'auto' as const, require: false }),
  }),
});
