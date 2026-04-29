import { z } from 'zod';

const ServerNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'server names must be alphanumeric with `-` or `_`');

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

export const AuthSchema = z.discriminatedUnion('type', [NoneAuthSchema, BearerAuthSchema]);

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

export const StdioServerSettingsSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const HttpServerSettingsSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().min(1),
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
    autoRevealExactServerMatches: z.boolean(),
    maxSearchResults: z.number().int().positive(),
  })
  .strict();

export const NamespacingSchema = z
  .object({
    separator: z.string().min(1).default('__'),
    format: z.enum(['server__tool']),
    collisionStrategy: z.enum(['error', 'rename', 'first-wins']),
  })
  .strict();

export const ToolboxConfigSchema = z
  .object({
    $schema: z.string().min(1).optional(),
    version: z.literal(1),
    server: ServerSettingsSchema,
    progressiveDisclosure: ProgressiveDisclosureSchema,
    namespacing: NamespacingSchema,
    servers: ServersMapSchema,
  })
  .strict();

export type ToolboxConfig = z.infer<typeof ToolboxConfigSchema>;
export type ToolboxConfigInput = z.input<typeof ToolboxConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;
export type ProgressiveDisclosureConfig = z.infer<typeof ProgressiveDisclosureSchema>;
export type NamespacingConfig = z.infer<typeof NamespacingSchema>;
