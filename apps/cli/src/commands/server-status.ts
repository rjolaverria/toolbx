import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import type { ServerConfig } from '@rjolaverria/toolbox-core';

import { probeServer, type ProbeResult, type ProbeServerFn } from './server-probe.js';
import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  parsePositiveInt,
  requireExistingServer,
  resolveTargetPath,
  type ServerCommandDeps,
} from './server-shared.js';

export interface StatusOptions {
  config?: string;
  json?: true;
  timeout?: number;
}

export interface StatusDeps extends ServerCommandDeps {
  probe: ProbeServerFn;
}

export function defaultStatusDeps(): StatusDeps {
  return {
    ...defaultServerCommandDeps(),
    probe: probeServer,
  };
}

interface JsonStatus {
  name: string;
  type: 'stdio' | 'http';
  enabled: boolean;
  status: 'disabled' | 'connected' | 'auth_required' | 'error';
  toolCount: number | null;
  connectedAt: string | null;
  authRequired: { reason: string } | null;
  error: { message: string } | null;
}

function buildJson(name: string, entry: ServerConfig, result: ProbeResult): JsonStatus {
  const base: Pick<JsonStatus, 'name' | 'type' | 'enabled'> = {
    name,
    type: entry.type,
    enabled: entry.enabled,
  };
  switch (result.kind) {
    case 'disabled':
      return {
        ...base,
        status: 'disabled',
        toolCount: null,
        connectedAt: null,
        authRequired: null,
        error: null,
      };
    case 'connected':
      return {
        ...base,
        status: 'connected',
        toolCount: result.tools.length,
        connectedAt: result.connectedAt.toISOString(),
        authRequired: null,
        error: null,
      };
    case 'auth_required':
      return {
        ...base,
        status: 'auth_required',
        toolCount: null,
        connectedAt: null,
        authRequired: { reason: result.reason },
        error: null,
      };
    case 'error':
      return {
        ...base,
        status: 'error',
        toolCount: null,
        connectedAt: null,
        authRequired: null,
        error: { message: result.error.message },
      };
  }
}

function formatHuman(name: string, entry: ServerConfig, result: ProbeResult): string {
  const lines: string[] = [];
  lines.push(`server: ${name}`);
  lines.push(`type: ${entry.type}`);
  lines.push(`enabled: ${entry.enabled ? 'yes' : 'no'}`);
  switch (result.kind) {
    case 'disabled':
      lines.push('status: disabled');
      break;
    case 'connected':
      lines.push('status: connected');
      lines.push(`tools: ${result.tools.length}`);
      lines.push(`connectedAt: ${result.connectedAt.toISOString()}`);
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

export async function runServerStatus(
  name: string,
  options: StatusOptions,
  deps: StatusDeps,
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

export function statusCommand(): CommandUnknownOpts {
  return new Command('status')
    .description('Probe a configured upstream MCP server and report its current state.')
    .argument('<name>', 'server name')
    .option('--json', 'emit machine-readable JSON instead of human output')
    .option(
      '--timeout <ms>',
      'override the probe timeout (defaults to the server timeoutMs)',
      parsePositiveInt,
    )
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (name, opts) => {
      const code = await runServerStatus(name, opts, defaultStatusDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
