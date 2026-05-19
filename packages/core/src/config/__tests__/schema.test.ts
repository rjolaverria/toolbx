import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  HttpServerConfigSchema,
  HttpServerSettingsSchema,
  StdioServerConfigSchema,
  ToolBoxConfigSchema,
  type HttpServerConfig,
  type ServerConfig,
  type StdioServerConfig,
  type ToolBoxConfig,
} from '../schema.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const SPECS_EXAMPLE = {
  $schema: 'https://toolbox.dev/schema/config.schema.json',
  version: 1,
  server: {
    stdio: { enabled: true },
    http: {
      enabled: true,
      host: '127.0.0.1',
      port: 7331,
      path: '/mcp',
    },
  },
  progressiveDisclosure: {
    enabled: true,
    mode: 'session',
    bootstrapTools: true,
    autoRevealExactServerMatches: true,
    maxSearchResults: 20,
  },
  namespacing: {
    separator: '__',
    format: 'server__tool',
    collisionStrategy: 'error',
  },
  auth: {
    storage: { type: 'keychain' },
  },
  servers: {
    jira: {
      type: 'http',
      enabled: true,
      url: 'https://jira.example.com/mcp',
      auth: {
        type: 'bearer',
        tokenEnv: 'JIRA_MCP_TOKEN',
      },
      timeoutMs: 60000,
    },
    github: {
      type: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: '${env:GITHUB_PERSONAL_ACCESS_TOKEN}',
      },
      timeoutMs: 60000,
    },
    'github-copilot': {
      type: 'http',
      enabled: true,
      url: 'https://api.githubcopilot.com/mcp/',
      auth: { type: 'oauth' },
      timeoutMs: 60000,
    },
  },
};

describe('ToolBoxConfigSchema', () => {
  it('accepts the SPECS §4.4 example verbatim', () => {
    const result = ToolBoxConfigSchema.safeParse(SPECS_EXAMPLE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.servers.jira?.type).toBe('http');
      expect(result.data.servers.github?.type).toBe('stdio');
    }
  });

  it('rejects unknown top-level keys', () => {
    const bad = { ...SPECS_EXAMPLE, extraneous: true };
    const result = ToolBoxConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects unknown nested keys in progressiveDisclosure', () => {
    const bad = {
      ...SPECS_EXAMPLE,
      progressiveDisclosure: {
        ...SPECS_EXAMPLE.progressiveDisclosure,
        ghost: 'no',
      },
    };
    const result = ToolBoxConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('fills the namespacing.separator default to "__" when omitted', () => {
    const namespacing = {
      // separator omitted on purpose
      format: 'server__tool',
      collisionStrategy: 'error',
    };
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      namespacing,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.namespacing.separator).toBe('__');
    }
  });

  it('rejects an explicit non-`__` namespacing.separator override (Phase 1 constraint)', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      namespacing: {
        ...SPECS_EXAMPLE.namespacing,
        separator: '::',
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('ServerConfig discriminated union', () => {
  it('rejects an unknown server type', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      servers: {
        weird: {
          type: 'grpc',
          enabled: true,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an http server with an invalid url', () => {
    const result = HttpServerConfigSchema.safeParse({
      type: 'http',
      enabled: true,
      url: 'not a url',
    });
    expect(result.success).toBe(false);
  });

  it.each([
    'mailto:user@example.com',
    'file:///etc/passwd',
    'ftp://example.com',
    'ws://example.com',
  ])('rejects an http server whose url is the non-http(s) scheme %s', (url) => {
    const result = HttpServerConfigSchema.safeParse({
      type: 'http',
      enabled: true,
      url,
    });
    expect(result.success).toBe(false);
  });

  it.each(['http://localhost:3000/mcp', 'https://jira.example.com/mcp'])(
    'accepts an http server with the http(s) url %s',
    (url) => {
      const result = HttpServerConfigSchema.safeParse({
        type: 'http',
        enabled: true,
        url,
      });
      expect(result.success).toBe(true);
    },
  );

  it('rejects a stdio server missing command', () => {
    const result = StdioServerConfigSchema.safeParse({
      type: 'stdio',
      enabled: true,
    });
    expect(result.success).toBe(false);
  });

  it('narrows the union by `type` at the type level', () => {
    const result = ToolBoxConfigSchema.safeParse(SPECS_EXAMPLE);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const config: ToolBoxConfig = result.data;
    const jira: ServerConfig | undefined = config.servers.jira;
    if (jira !== undefined && jira.type === 'http') {
      const http: HttpServerConfig = jira;
      expect(http.url).toBe('https://jira.example.com/mcp');
    }
    const github: ServerConfig | undefined = config.servers.github;
    if (github !== undefined && github.type === 'stdio') {
      const stdio: StdioServerConfig = github;
      expect(stdio.command).toBe('npx');
    }
  });

  it('rejects bearer auth without tokenEnv', () => {
    const result = HttpServerConfigSchema.safeParse({
      type: 'http',
      enabled: true,
      url: 'https://example.com/mcp',
      auth: { type: 'bearer' },
    });
    expect(result.success).toBe(false);
  });

  it('parses an http server with `auth: { type: "oauth" }`', () => {
    const result = HttpServerConfigSchema.safeParse({
      type: 'http',
      enabled: true,
      url: 'https://api.githubcopilot.com/mcp/',
      auth: { type: 'oauth' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.auth).toEqual({ type: 'oauth' });
    }
  });

  it('rejects oauth auth carrying extra fields', () => {
    const result = HttpServerConfigSchema.safeParse({
      type: 'http',
      enabled: true,
      url: 'https://api.githubcopilot.com/mcp/',
      // OAuth carries no client-info fields in config; those live in the
      // TokenStore. Extra keys must be rejected by `.strict()`.
      auth: { type: 'oauth', clientId: 'leaked-into-config' },
    });
    expect(result.success).toBe(false);
  });
});

describe('Server name validation', () => {
  it('rejects a server name containing the namespacing separator `__`', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      servers: {
        jira__bad: {
          type: 'http',
          enabled: true,
          url: 'https://jira.example.com/mcp',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a server name with single underscores', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      servers: {
        my_server: {
          type: 'http',
          enabled: true,
          url: 'https://example.com/mcp',
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('Tool overrides map', () => {
  it('defaults `tools` to an empty record when omitted', () => {
    const result = ToolBoxConfigSchema.safeParse(SPECS_EXAMPLE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toEqual({});
    }
  });

  it('accepts a per-tool enabled override keyed on the namespaced name', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      tools: {
        github__create_issue: { enabled: false },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools['github__create_issue']?.enabled).toBe(false);
    }
  });

  it('rejects tool override keys that are not namespaced', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      tools: {
        not_namespaced: { enabled: false },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields inside a tool override', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      tools: {
        github__create_issue: { enabled: false, ghost: 'no' },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('HttpServerSettings host validation', () => {
  it.each(['127.0.0.1', '::1', 'localhost'])('accepts loopback host %s', (host) => {
    const result = HttpServerSettingsSchema.safeParse({
      enabled: true,
      host,
      port: 7331,
      path: '/mcp',
    });
    expect(result.success).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'example.com', '10.0.0.5'])(
    'rejects non-loopback host %s',
    (host) => {
      const result = HttpServerSettingsSchema.safeParse({
        enabled: true,
        host,
        port: 7331,
        path: '/mcp',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/loopback/);
      }
    },
  );
});

describe('Top-level auth + token storage', () => {
  it('resolves `auth.storage` to `{ type: "keychain" }` when the whole auth block is omitted', () => {
    const { auth: _omitted, ...withoutAuth } = SPECS_EXAMPLE;
    void _omitted;
    const result = ToolBoxConfigSchema.safeParse(withoutAuth);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.auth.storage).toEqual({ type: 'keychain' });
    }
  });

  it('resolves `auth.storage` to `{ type: "keychain" }` when only the storage field is omitted', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      auth: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.auth.storage).toEqual({ type: 'keychain' });
    }
  });

  it('accepts an explicit `auth.storage.type: "keychain"`', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      auth: { storage: { type: 'keychain' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.auth.storage.type).toBe('keychain');
    }
  });

  it('rejects an unknown `auth.storage.type` with a clear error path', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      auth: { storage: { type: 'unknown' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Ensure the error points at the right path so users editing the
      // config by hand get a useful "auth.storage.type" hint.
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths.some((p) => p.startsWith('auth.storage'))).toBe(true);
    }
  });

  it('rejects unknown keys inside the top-level `auth` block', () => {
    const result = ToolBoxConfigSchema.safeParse({
      ...SPECS_EXAMPLE,
      auth: { storage: { type: 'keychain' }, ghost: 'no' },
    });
    expect(result.success).toBe(false);
  });
});

describe('Auth round-trip', () => {
  it('parses through a config that uses every `auth.type` variant', () => {
    const allVariants = {
      ...SPECS_EXAMPLE,
      servers: {
        ...SPECS_EXAMPLE.servers,
        'no-auth': {
          type: 'http' as const,
          enabled: true,
          url: 'https://no-auth.example.com/mcp',
          auth: { type: 'none' as const },
        },
      },
    };
    const first = ToolBoxConfigSchema.safeParse(allVariants);
    expect(first.success).toBe(true);
    if (!first.success) {
      return;
    }
    // Serialize through JSON to drop any default-injected fields back to
    // their input shape, then re-parse and confirm the typed result is
    // structurally equal. This catches accidental schema drift where a
    // .transform() or .default() turns the value into something that no
    // longer round-trips.
    const serialized = JSON.parse(JSON.stringify(first.data)) as unknown;
    const second = ToolBoxConfigSchema.safeParse(serialized);
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.data).toEqual(first.data);
    }
  });
});

describe('SPECS §4.4 example parses through ToolBoxConfigSchema', () => {
  it('extracts the first JSON block under "## 4.4 Example Config File" and parses it cleanly', () => {
    // Read the canonical spec at test time so the schema and the documented
    // example stay in lockstep — drift in either direction fails the build.
    const specsPath = resolve(__dirname, '../../../../../.agents/SPECS.md');
    const specs = readFileSync(specsPath, 'utf8');
    const headingIndex = specs.indexOf('## 4.4 Example Config File');
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    const afterHeading = specs.slice(headingIndex);
    const fenceMatch = /```json\n([\s\S]*?)\n```/.exec(afterHeading);
    expect(fenceMatch).not.toBeNull();
    const example: unknown = JSON.parse(fenceMatch?.[1] ?? '');
    const result = ToolBoxConfigSchema.safeParse(example);
    expect(result.success).toBe(true);
    if (result.success) {
      // Belt-and-suspenders: the OAuth server defined in the spec example
      // must round-trip through the new union variant.
      const copilot = result.data.servers['github-copilot'];
      expect(copilot?.type).toBe('http');
      if (copilot?.type === 'http') {
        expect(copilot.auth).toEqual({ type: 'oauth' });
      }
      expect(result.data.auth.storage).toEqual({ type: 'keychain' });
    }
  });
});
