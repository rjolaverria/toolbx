import { z } from 'zod';

export const ServerNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'server names must be alphanumeric with `-` or `_`')
  // The `__` substring is reserved as the namespacing separator (M3-01); a
  // server name that contains it makes `parseExposedName` ambiguous.
  .refine((value) => !value.includes('__'), {
    message: 'server names must not contain the `__` namespacing separator',
  });

const TimeoutMsSchema = z.number().int().positive();

const EnvMapSchema = z.record(z.string().min(1), z.string());

export const NoneAuthSchema = z
  .object({
    type: z.literal('none'),
  })
  .strict();

export const BearerAuthSchema = z
  .object({
    type: z.literal('bearer'),
    tokenEnv: z.string().min(1),
  })
  .strict();

// OAuth-typed servers carry no fields in `config.json`: the DCR-issued
// clientInformation, granted scopes, etc. live in the TokenStore (F1-13), not
// in the user-editable config. The presence of `auth: { type: 'oauth' }` is
// the signal that the gateway should drive the OAuth 2.1 dance for this
// server.
export const OAuthAuthSchema = z
  .object({
    type: z.literal('oauth'),
  })
  .strict();

export const AuthSchema = z.discriminatedUnion('type', [
  NoneAuthSchema,
  BearerAuthSchema,
  OAuthAuthSchema,
]);

export const StdioServerConfigSchema = z
  .object({
    type: z.literal('stdio'),
    enabled: z.boolean(),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: EnvMapSchema.optional(),
    cwd: z.string().min(1).optional(),
    timeoutMs: TimeoutMsSchema.optional(),
  })
  .strict();

export const HttpServerConfigSchema = z
  .object({
    type: z.literal('http'),
    enabled: z.boolean(),
    url: z.url({ protocol: /^https?$/ }),
    headers: z.record(z.string().min(1), z.string()).optional(),
    auth: AuthSchema.optional(),
    timeoutMs: TimeoutMsSchema.optional(),
  })
  .strict();

export const ServerConfigSchema = z.discriminatedUnion('type', [
  StdioServerConfigSchema,
  HttpServerConfigSchema,
]);

export const ServersMapSchema = z.record(ServerNameSchema, ServerConfigSchema);

// Exposed (namespaced) tool name shape, e.g. `github__create_issue`. The
// canonical exposed name is produced by `formatExposedName` in
// `@toolbox/core`'s namespace module (which concatenates a validated server
// name and an upstream tool name); this regex is a defensive sanity check
// for hand-edited config so obvious nonsense like spaces or empty segments
// can't slip through to tool overrides.
const ExposedToolNameSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9][a-z0-9_-]*__[a-z0-9][a-z0-9_-]*$/i,
    'tool override keys must be `<server>__<tool>` namespaced names',
  );

export const ToolOverrideSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const ToolOverridesMapSchema = z.record(ExposedToolNameSchema, ToolOverrideSchema);

export const StdioServerSettingsSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

// Phase 1 binds the downstream ToolBox HTTP server to loopback only. Allowing
// `0.0.0.0` or LAN IPs would expose ToolBox without auth (Phase 1 has none),
// so non-loopback hosts are rejected at config load. Future tasks may relax
// this once auth ships.
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

export const LoopbackHostSchema = z
  .string()
  .min(1)
  .refine((value) => (LOOPBACK_HOSTS as readonly string[]).includes(value), {
    message: `host must be one of ${LOOPBACK_HOSTS.join(', ')} (Phase 1 binds loopback only)`,
  });

export const HttpServerSettingsSchema = z
  .object({
    enabled: z.boolean(),
    host: LoopbackHostSchema,
    port: z.number().int().min(1).max(65535),
    path: z.string().startsWith('/'),
  })
  .strict();

export const ServerSettingsSchema = z
  .object({
    stdio: StdioServerSettingsSchema,
    http: HttpServerSettingsSchema,
  })
  .strict();

export const ProgressiveDisclosureSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(['session', 'global']),
    bootstrapTools: z.boolean(),
    autoRevealExactServerMatches: z.boolean().default(true),
    maxSearchResults: z.number().int().positive(),
  })
  .strict();

export const NamespacingSchema = z
  .object({
    // Phase 1 only supports the `__` separator (M3-01). Other values are
    // rejected at config load so the namespace module never has to handle
    // them at runtime.
    separator: z.literal('__').default('__'),
    format: z.enum(['server__tool']),
    collisionStrategy: z.enum(['error', 'rename', 'first-wins']),
  })
  .strict();

// Token-store backend selector for OAuth credentials and other per-server
// secrets that ToolBox manages itself. Phase 1 ships a single backend
// (`keychain`) backed by the OS keyring; future backends (e.g. `file`,
// `memory` for tests) will join this union.
export const TokenStorageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('keychain') }).strict(),
]);

// The top-level `auth` block scopes ToolBox-wide auth settings, currently
// just the token-store backend. Defaulted in two layers so consumers always
// see `config.auth.storage.type` resolved without conditional reads:
//   - `storage` defaults to `{ type: 'keychain' }` when omitted
//   - the whole `auth` block defaults to `{ storage: { type: 'keychain' } }`
//     when omitted
export const TopLevelAuthSchema = z
  .object({
    storage: TokenStorageSchema.default({ type: 'keychain' }),
  })
  .strict();

export const ToolBoxConfigSchema = z
  .object({
    $schema: z.string().min(1).optional(),
    version: z.literal(1),
    server: ServerSettingsSchema,
    progressiveDisclosure: ProgressiveDisclosureSchema,
    namespacing: NamespacingSchema,
    auth: TopLevelAuthSchema.default({ storage: { type: 'keychain' } }),
    servers: ServersMapSchema,
    tools: ToolOverridesMapSchema.default({}),
  })
  .strict();

export type ToolBoxConfig = z.infer<typeof ToolBoxConfigSchema>;
export type ToolBoxConfigInput = z.input<typeof ToolBoxConfigSchema>;
export type ToolOverride = z.infer<typeof ToolOverrideSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;
export type ProgressiveDisclosureConfig = z.infer<typeof ProgressiveDisclosureSchema>;
export type NamespacingConfig = z.infer<typeof NamespacingSchema>;
export type TokenStorage = z.infer<typeof TokenStorageSchema>;
export type TopLevelAuth = z.infer<typeof TopLevelAuthSchema>;
