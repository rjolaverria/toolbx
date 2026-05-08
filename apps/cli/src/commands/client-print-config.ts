import { Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import type { ToolBoxConfig } from '@toolbox/core';

import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  resolveTargetPath,
  type ServerCommandDeps,
} from './server-shared.js';

export const SUPPORTED_CLIENTS = ['claude', 'codex', 'opencode', 'generic'] as const;
export type ClientId = (typeof SUPPORTED_CLIENTS)[number];

export type Transport = 'stdio' | 'http';

export interface PrintConfigOptions {
  stdio?: true;
  http?: true;
  json?: true;
  config?: string;
}

interface Snippet {
  readonly description: string;
  readonly json: Record<string, unknown>;
  // When set, this is the canonical paste-ready form rendered in friendly mode
  // (e.g. TOML for Codex). `--json` always emits `json` regardless.
  readonly native?: { readonly language: string; readonly body: string };
}

const STDIO_COMMAND = 'npx';
const STDIO_ARGS: readonly string[] = ['-y', 'tlbx', 'serve', '--stdio'];

function isClientId(value: string): value is ClientId {
  return (SUPPORTED_CLIENTS as readonly string[]).includes(value);
}

function buildHttpUrl(http: ToolBoxConfig['server']['http']): string {
  const host = http.host === '::1' ? '[::1]' : http.host;
  return `http://${host}:${String(http.port)}${http.path}`;
}

function tomlString(value: string): string {
  // Basic TOML strings share the JSON escape vocabulary for everything we
  // emit here (npx, --stdio, http URLs); JSON.stringify is therefore a safe
  // serializer for our limited inputs and avoids pulling in a TOML library.
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function codexStdioToml(): string {
  return [
    '[mcp_servers.toolbox]',
    `command = ${tomlString(STDIO_COMMAND)}`,
    `args = ${tomlStringArray(STDIO_ARGS)}`,
    '',
  ].join('\n');
}

function codexHttpToml(url: string): string {
  return ['[mcp_servers.toolbox]', `url = ${tomlString(url)}`, ''].join('\n');
}

function claudeSnippet(transport: Transport, http: ToolBoxConfig['server']['http']): Snippet {
  if (transport === 'stdio') {
    return {
      description:
        'Add this to your Claude Desktop MCP config (claude_desktop_config.json), then restart Claude Desktop:',
      json: {
        mcpServers: {
          toolbox: {
            command: STDIO_COMMAND,
            args: [...STDIO_ARGS],
          },
        },
      },
    };
  }
  return {
    description:
      'Add this to your Claude Desktop MCP config (claude_desktop_config.json) after starting `tlbx serve --http`, then restart Claude Desktop:',
    json: {
      mcpServers: {
        toolbox: {
          url: buildHttpUrl(http),
        },
      },
    },
  };
}

function codexSnippet(transport: Transport, http: ToolBoxConfig['server']['http']): Snippet {
  if (transport === 'stdio') {
    return {
      description:
        'Add this to your Codex CLI MCP config (~/.codex/config.toml) so Codex launches ToolBox over stdio on demand:',
      json: {
        mcp_servers: {
          toolbox: {
            command: STDIO_COMMAND,
            args: [...STDIO_ARGS],
          },
        },
      },
      native: { language: 'toml', body: codexStdioToml() },
    };
  }
  return {
    description:
      'Run `tlbx serve --http` first, then add this to your Codex CLI MCP config (~/.codex/config.toml) to point it at the running ToolBox:',
    json: {
      mcp_servers: {
        toolbox: {
          url: buildHttpUrl(http),
        },
      },
    },
    native: { language: 'toml', body: codexHttpToml(buildHttpUrl(http)) },
  };
}

function opencodeSnippet(transport: Transport, http: ToolBoxConfig['server']['http']): Snippet {
  if (transport === 'stdio') {
    return {
      description: 'Add this to your OpenCode MCP config so OpenCode launches ToolBox over stdio:',
      json: {
        mcp: {
          toolbox: {
            type: 'local',
            command: [STDIO_COMMAND, ...STDIO_ARGS],
            enabled: true,
          },
        },
      },
    };
  }
  return {
    description:
      'Run `tlbx serve --http` first, then add this to your OpenCode MCP config to point it at the running ToolBox:',
    json: {
      mcp: {
        toolbox: {
          type: 'remote',
          url: buildHttpUrl(http),
          enabled: true,
        },
      },
    },
  };
}

function genericSnippet(transport: Transport, http: ToolBoxConfig['server']['http']): Snippet {
  if (transport === 'stdio') {
    return {
      description:
        'Generic MCP client (stdio). Most clients accept this shape; consult your client docs for the exact config key:',
      json: {
        mcpServers: {
          toolbox: {
            command: STDIO_COMMAND,
            args: [...STDIO_ARGS],
          },
        },
      },
    };
  }
  return {
    description:
      'Generic MCP client (Streamable HTTP). Run `tlbx serve --http` first, then point your client at this URL:',
    json: {
      mcpServers: {
        toolbox: {
          url: buildHttpUrl(http),
        },
      },
    },
  };
}

function snippetFor(
  client: ClientId,
  transport: Transport,
  http: ToolBoxConfig['server']['http'],
): Snippet {
  switch (client) {
    case 'claude':
      return claudeSnippet(transport, http);
    case 'codex':
      return codexSnippet(transport, http);
    case 'opencode':
      return opencodeSnippet(transport, http);
    case 'generic':
      return genericSnippet(transport, http);
  }
}

function renderFriendly(snippet: Snippet): string {
  if (snippet.native !== undefined) {
    return `${snippet.description}\n\n\`\`\`${snippet.native.language}\n${snippet.native.body}\`\`\`\n`;
  }
  const json = JSON.stringify(snippet.json, null, 2);
  return `${snippet.description}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

function renderJson(snippet: Snippet): string {
  return `${JSON.stringify(snippet.json, null, 2)}\n`;
}

export async function runClientPrintConfig(
  client: string,
  options: PrintConfigOptions,
  deps: ServerCommandDeps,
): Promise<number> {
  if (!isClientId(client)) {
    deps.stderr(
      `Unknown client "${client}". Supported clients: ${SUPPORTED_CLIENTS.join(', ')}.\n`,
    );
    return 1;
  }
  if (options.stdio === true && options.http === true) {
    deps.stderr('tlbx client print-config: --stdio and --http are mutually exclusive\n');
    return 2;
  }
  const transport: Transport = options.http === true ? 'http' : 'stdio';

  let http: ToolBoxConfig['server']['http'];
  if (transport === 'http') {
    const target = resolveTargetPath(deps, options.config);
    const config = await loadOrReportMissing(target, deps);
    if (config === null) {
      return 1;
    }
    if (!config.server.http.enabled) {
      deps.stderr(
        'tlbx client print-config: --http requested but server.http.enabled is false in config; enable it first or pick --stdio.\n',
      );
      return 1;
    }
    http = config.server.http;
  } else {
    // stdio snippets do not depend on config; using a placeholder keeps the
    // snippet builder signature uniform without forcing users to run
    // `tlbx init` before they can read the primary onboarding snippet.
    http = { enabled: true, host: '127.0.0.1', port: 0, path: '/' };
  }

  const snippet = snippetFor(client, transport, http);
  deps.stdout(options.json === true ? renderJson(snippet) : renderFriendly(snippet));
  return 0;
}

function parseClient(value: string): string {
  if (!isClientId(value)) {
    throw new InvalidArgumentError(
      `unknown client "${value}". Supported: ${SUPPORTED_CLIENTS.join(', ')}.`,
    );
  }
  return value;
}

export function clientCommand(): Command {
  const cmd = new Command('client').description('Print MCP client setup snippets for ToolBox.');

  cmd
    .command('print-config')
    .description('Print a copy-paste MCP config snippet for the chosen client.')
    .argument('<client>', `target client (${SUPPORTED_CLIENTS.join(' | ')})`, parseClient)
    .addOption(new Option('--stdio', 'render the stdio transport snippet (default)'))
    .addOption(new Option('--http', 'render the Streamable HTTP transport snippet'))
    .addOption(
      new Option(
        '--json',
        'emit a machine-readable JSON representation of the snippet, with no surrounding prose (note: clients with non-JSON native config — e.g. Codex TOML — should paste the default friendly output instead)',
      ),
    )
    .option('-c, --config <path>', 'override the resolved config path (used by --http)')
    .action(async (client, opts) => {
      const code = await runClientPrintConfig(client, opts, defaultServerCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });

  return cmd;
}
