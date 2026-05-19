import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import type { ServerConfig } from '@toolbox/core';
import type { ListToolsResult } from '@toolbox/mcp-gateway';

import { probeServer, type ProbeResult, type ProbeServerFn } from './server-probe.js';
import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  parsePositiveInt,
  requireExistingServer,
  resolveTargetPath,
  type ServerCommandDeps,
} from './server-shared.js';

export interface InspectOptions {
  config?: string;
  json?: true;
  timeout?: number;
}

export interface InspectDeps extends ServerCommandDeps {
  probe: ProbeServerFn;
}

export function defaultInspectDeps(): InspectDeps {
  return {
    ...defaultServerCommandDeps(),
    probe: probeServer,
  };
}

interface AuthSummary {
  type: 'none' | 'bearer' | 'oauth';
  tokenEnv?: string;
}

function authSummary(entry: ServerConfig): AuthSummary {
  if (entry.type === 'http' && entry.auth !== undefined) {
    switch (entry.auth.type) {
      case 'bearer':
        return { type: 'bearer', tokenEnv: entry.auth.tokenEnv };
      case 'oauth':
        return { type: 'oauth' };
      case 'none':
        return { type: 'none' };
    }
  }
  return { type: 'none' };
}

interface InspectJsonStatus {
  kind: ProbeResult['kind'];
  toolCount: number | null;
  connectedAt: string | null;
  authReason: string | null;
  errorMessage: string | null;
}

interface InspectJsonTool {
  name: string;
  description: string | null;
}

interface InspectJson {
  name: string;
  config: ServerConfig;
  transport: 'stdio' | 'http';
  auth: AuthSummary;
  status: InspectJsonStatus;
  tools: InspectJsonTool[] | null;
}

function summarizeStatus(result: ProbeResult): InspectJsonStatus {
  switch (result.kind) {
    case 'disabled':
      return {
        kind: 'disabled',
        toolCount: null,
        connectedAt: null,
        authReason: null,
        errorMessage: null,
      };
    case 'connected':
      return {
        kind: 'connected',
        toolCount: result.tools.length,
        connectedAt: result.connectedAt.toISOString(),
        authReason: null,
        errorMessage: null,
      };
    case 'auth_required':
      return {
        kind: 'auth_required',
        toolCount: null,
        connectedAt: null,
        authReason: result.reason,
        errorMessage: null,
      };
    case 'error':
      return {
        kind: 'error',
        toolCount: null,
        connectedAt: null,
        authReason: null,
        errorMessage: result.error.message,
      };
  }
}

function summarizeTools(tools: ListToolsResult['tools']): InspectJsonTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? null,
  }));
}

function buildJson(name: string, entry: ServerConfig, result: ProbeResult): InspectJson {
  return {
    name,
    config: entry,
    transport: entry.type,
    auth: authSummary(entry),
    status: summarizeStatus(result),
    tools: result.kind === 'connected' ? summarizeTools(result.tools) : null,
  };
}

function formatHuman(name: string, entry: ServerConfig, result: ProbeResult): string {
  const lines: string[] = [];
  lines.push(`server: ${name}`);
  lines.push(`transport: ${entry.type}`);
  lines.push(`enabled: ${entry.enabled ? 'yes' : 'no'}`);
  const auth = authSummary(entry);
  switch (auth.type) {
    case 'bearer':
      lines.push(`auth: bearer (token env: ${auth.tokenEnv ?? '(unset)'})`);
      break;
    case 'oauth':
      lines.push('auth: oauth');
      break;
    case 'none':
      lines.push('auth: none');
      break;
  }
  if (entry.timeoutMs !== undefined) {
    lines.push(`timeoutMs: ${entry.timeoutMs}`);
  }
  lines.push('');
  lines.push('config:');
  lines.push(JSON.stringify(entry, null, 2));
  lines.push('');
  switch (result.kind) {
    case 'disabled':
      lines.push('status: disabled');
      break;
    case 'connected':
      lines.push('status: connected');
      lines.push(`connectedAt: ${result.connectedAt.toISOString()}`);
      lines.push(`tools (${result.tools.length}):`);
      for (const tool of result.tools) {
        const desc = tool.description ?? '';
        lines.push(`  - ${tool.name}${desc ? `: ${desc}` : ''}`);
      }
      break;
    case 'auth_required':
      lines.push('status: auth_required');
      lines.push(`reason: ${result.reason}`);
      break;
    case 'error':
      lines.push('status: error');
      lines.push(`error: ${result.error.message}`);
      break;
  }
  return `${lines.join('\n')}\n`;
}

function exitCodeFor(result: ProbeResult): number {
  return result.kind === 'error' ? 1 : 0;
}

export async function runServerInspect(
  name: string,
  options: InspectOptions,
  deps: InspectDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }
  const entry = requireExistingServer(config, name, target, deps);
  if (entry === null) {
    return 1;
  }

  const probeOptions: { timeoutMs?: number } = {};
  if (options.timeout !== undefined) {
    probeOptions.timeoutMs = options.timeout;
  }
  const result = await deps.probe(name, entry, probeOptions);

  if (options.json === true) {
    deps.stdout(`${JSON.stringify(buildJson(name, entry, result), null, 2)}\n`);
  } else {
    deps.stdout(formatHuman(name, entry, result));
  }
  return exitCodeFor(result);
}

export function inspectCommand(): CommandUnknownOpts {
  return new Command('inspect')
    .description('Show full config plus discovered tools and live status for a server.')
    .argument('<name>', 'server name')
    .option('--json', 'emit machine-readable JSON instead of human output')
    .option(
      '--timeout <ms>',
      'override the probe timeout (defaults to the server timeoutMs)',
      parsePositiveInt,
    )
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (name, opts) => {
      const code = await runServerInspect(name, opts, defaultInspectDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
