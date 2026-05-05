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
  readonly config: Record<string, unknown>;
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

function claudeSnippet(transport: Transport, http: ToolBoxConfig['server']['http']): Snippet {
  if (transport === 'stdio') {
    return {
      description:
        'Add this to your Claude Desktop MCP config (claude_desktop_config.json), then restart Claude Desktop:',
      config: {
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
    config: {
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
        'Add this to your Codex CLI MCP config so Codex launches ToolBox over stdio on demand:',
      config: {
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
      'Run `tlbx serve --http` first, then add this to your Codex CLI MCP config to point it at the running ToolBox:',
    config: {
      mcpServers: {
        toolbox: {
          url: buildHttpUrl(http),
        },
      },
    },
  };
}

function opencodeSnippet(transport: Transport, http: ToolBoxConfig['server']['http']): Snippet {
  if (transport === 'stdio') {
    return {
      description: 'Add this to your OpenCode MCP config so OpenCode launches ToolBox over stdio:',
      config: {
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
    config: {
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
      config: {
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
    config: {
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
  const json = JSON.stringify(snippet.config, null, 2);
  return `${snippet.description}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

function renderJson(snippet: Snippet): string {
  return `${JSON.stringify(snippet.config, null, 2)}\n`;
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
    .addOption(new Option('--json', 'emit only the JSON snippet, with no surrounding prose'))
    .option('-c, --config <path>', 'override the resolved config path (used by --http)')
    .action(async (client, opts) => {
      const code = await runClientPrintConfig(client, opts, defaultServerCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });

  return cmd;
}
