import { describe, expect, it } from 'vitest';

import {
  HttpServerConfigSchema,
  StdioServerConfigSchema,
  ToolboxConfigSchema,
  type HttpServerConfig,
  type ServerConfig,
  type StdioServerConfig,
  type ToolboxConfig,
} from '../schema.js';

const README_EXAMPLE = {
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

describe('ToolboxConfigSchema', () => {
  it('accepts the README §4.4 example verbatim', () => {
    const result = ToolboxConfigSchema.safeParse(README_EXAMPLE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.servers.jira?.type).toBe('http');
      expect(result.data.servers.github?.type).toBe('stdio');
    }
  });

  it('rejects unknown top-level keys', () => {
    const bad = { ...README_EXAMPLE, extraneous: true };
    const result = ToolboxConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects unknown nested keys in progressiveDisclosure', () => {
    const bad = {
      ...README_EXAMPLE,
      progressiveDisclosure: {
        ...README_EXAMPLE.progressiveDisclosure,
        ghost: 'no',
      },
    };
    const result = ToolboxConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('fills the namespacing.separator default to "__" when omitted', () => {
    const namespacing = {
      // separator omitted on purpose
      format: 'server__tool',
      collisionStrategy: 'error',
    };
    const result = ToolboxConfigSchema.safeParse({
      ...README_EXAMPLE,
      namespacing,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.namespacing.separator).toBe('__');
    }
  });

  it('accepts an explicit non-default namespacing.separator override', () => {
    const result = ToolboxConfigSchema.safeParse({
      ...README_EXAMPLE,
      namespacing: {
        ...README_EXAMPLE.namespacing,
        separator: '::',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.namespacing.separator).toBe('::');
    }
  });
});

describe('ServerConfig discriminated union', () => {
  it('rejects an unknown server type', () => {
    const result = ToolboxConfigSchema.safeParse({
      ...README_EXAMPLE,
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

  it('rejects a stdio server missing command', () => {
    const result = StdioServerConfigSchema.safeParse({
      type: 'stdio',
      enabled: true,
    });
    expect(result.success).toBe(false);
  });

  it('narrows the union by `type` at the type level', () => {
    const result = ToolboxConfigSchema.safeParse(README_EXAMPLE);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const config: ToolboxConfig = result.data;
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
