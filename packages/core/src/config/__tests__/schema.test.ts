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
