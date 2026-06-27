import { Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import { TOOLBX_NPX_COMMAND, TOOLBX_STDIO_ARGS, type ToolbxConfig } from '@toolbx/core';

import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  resolveTargetPath,
  type ServerCommandDeps,
} from './server-shared.js';

export const SUPPORTED_CLIENTS = ['claude', 'codex', 'opencode', 'generic'] as const;
export type ClientId = (typeof SUPPORTED_CLIENTS)[number];

const SUPPORTED_CLIENT_HINT = 'claude (Claude Code) | codex | opencode | generic';

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

const STDIO_COMMAND = TOOLBX_NPX_COMMAND;
const STDIO_ARGS = TOOLBX_STDIO_ARGS;

function isClientId(value: string): value is ClientId {
  return (SUPPORTED_CLIENTS as readonly string[]).includes(value);
}

function buildHttpUrl(http: ToolbxConfig['server']['http']): string {
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
    '[mcp_servers.toolbx]',
    `command = ${tomlString(STDIO_COMMAND)}`,
    `args = ${tomlStringArray(STDIO_ARGS)}`,
    '',
  ].join('\n');
}

function codexHttpToml(url: string): string {
  return ['[mcp_servers.toolbx]', `url = ${tomlString(url)}`, ''].join('\n');
}

const CLAUDE_CODE_LOCATION =
  "Open Claude Code's user-scope MCP config — `~/.claude.json` on POSIX, `%USERPROFILE%\\.claude.json` on Windows.";
const CLAUDE_CODE_INSTALL_HINT =
  'Tip: `tlbx client install claude` writes the same entry for you (with a timestamped backup).';

function claudeSnippet(transport: Transport, http: ToolbxConfig['server']['http']): Snippet {
  if (transport === 'stdio') {
    return {
      description: [
        CLAUDE_CODE_LOCATION,
        "Merge the JSON block below into the file's top-level `mcpServers` object so Claude Code launches Toolbx over stdio on demand.",
        CLAUDE_CODE_INSTALL_HINT,
      ].join('\n\n'),
      json: {
        mcpServers: {
          toolbx: {
            type: 'stdio',
            command: STDIO_COMMAND,
            args: [...STDIO_ARGS],
            env: {},
          },
        },
      },
    };
  }
  // The `client install claude` hint is intentionally omitted here:
  // `install` only writes the stdio entry, so suggesting it under --http
  // would point users at the wrong shape.
  return {
    description: [
      CLAUDE_CODE_LOCATION,
      "Run `tlbx serve --http` first, then merge the JSON block below into the file's top-level `mcpServers` object so Claude Code points at the running Toolbx.",
    ].join('\n\n'),
    json: {
      mcpServers: {
        toolbx: {
          type: 'http',
          url: buildHttpUrl(http),
        },
      },
    },
  };
}

function codexSnippet(transport: Transport, http: ToolbxConfig['server']['http']): Snippet {
  if (transport === 'stdio') {
    return {
      description:
        'Add this to your Codex CLI MCP config (~/.codex/config.toml) so Codex launches Toolbx over stdio on demand:',
      json: {
        mcp_servers: {
          toolbx: {
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
      'Run `tlbx serve --http` first, then add this to your Codex CLI MCP config (~/.codex/config.toml) to point it at the running Toolbx:',
    json: {
      mcp_servers: {
        toolbx: {
          url: buildHttpUrl(http),
        },
      },
    },
    native: { language: 'toml', body: codexHttpToml(buildHttpUrl(http)) },
  };
}

function opencodeSnippet(transport: Transport, http: ToolbxConfig['server']['http']): Snippet {
  if (transport === 'stdio') {
    return {
      description: 'Add this to your OpenCode MCP config so OpenCode launches Toolbx over stdio:',
      json: {
        mcp: {
          toolbx: {
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
      'Run `tlbx serve --http` first, then add this to your OpenCode MCP config to point it at the running Toolbx:',
    json: {
      mcp: {
        toolbx: {
          type: 'remote',
          url: buildHttpUrl(http),
          enabled: true,
        },
      },
    },
  };
}

function genericSnippet(transport: Transport, http: ToolbxConfig['server']['http']): Snippet {
  if (transport === 'stdio') {
    return {
      description:
        'Generic MCP client (stdio). Most clients accept this shape; consult your client docs for the exact config key:',
      json: {
        mcpServers: {
          toolbx: {
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
        toolbx: {
          url: buildHttpUrl(http),
        },
      },
    },
  };
}

function snippetFor(
  client: ClientId,
  transport: Transport,
  http: ToolbxConfig['server']['http'],
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

  let http: ToolbxConfig['server']['http'];
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

export function clientCommand(registerExtras: ReadonlyArray<(cmd: Command) => void> = []): Command {
  const cmd = new Command('client').description('Configure MCP clients for Toolbx.');

  cmd
    .command('print-config')
    .description('Print a copy-paste MCP config snippet for the chosen client.')
    .argument('<client>', `target client (${SUPPORTED_CLIENT_HINT})`, parseClient)
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

  for (const register of registerExtras) {
    register(cmd);
  }

  return cmd;
}
