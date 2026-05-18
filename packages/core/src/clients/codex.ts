import * as fs from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import * as path from 'node:path';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import {
  runInstallFlow,
  type InstallFlowMergeResult,
  type InternalInstallFlowHooks,
} from './install-flow.js';
import type {
  ClientAdapter,
  ClientAdapterEnv,
  DetectedClient,
  InstallOpts,
  InstallResult,
} from './types.js';

const CODEX_CONFIG_REL = path.join('.codex', 'config.toml');
const MCP_SERVERS_KEY = 'mcp_servers';
const TOOLBOX_KEY = 'toolbox';

interface ToolboxEntry {
  command: string;
  args: string[];
}

const TOOLBOX_ENTRY: ToolboxEntry = {
  command: 'npx',
  args: ['-y', 'tlbx', 'serve', '--stdio'],
};

export type CreateCodexAdapterOptions = ClientAdapterEnv;
export type InternalInstallHooks = InternalInstallFlowHooks;

export function createCodexAdapter(options: CreateCodexAdapterOptions = {}): ClientAdapter {
  return createCodexAdapterInternal(options, {});
}

export function createCodexAdapterInternal(
  options: CreateCodexAdapterOptions,
  hooks: InternalInstallHooks,
): ClientAdapter {
  const homedir = options.homedir ?? osHomedir;
  const configPath = path.join(homedir(), CODEX_CONFIG_REL);

  return {
    name: 'codex',
    configPath,
    async detect(): Promise<DetectedClient | null> {
      try {
        await fs.stat(configPath);
        return { name: 'codex', configPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    async install(opts: InstallOpts): Promise<InstallResult> {
      return runInstallFlow({
        configPath,
        opts,
        hooks,
        merge: ({ currentText, exists, configPath: resolvedPath }) =>
          mergeCodexConfig({ currentText, exists, configPath: resolvedPath, opts }),
      });
    },
  };
}

export const codexAdapter: ClientAdapter = createCodexAdapter();

interface MergeInput {
  readonly currentText: string;
  readonly exists: boolean;
  readonly configPath: string;
  readonly opts: InstallOpts;
}

function mergeCodexConfig(input: MergeInput): InstallFlowMergeResult {
  const { currentText, exists, configPath, opts } = input;
  if (!exists) {
    const dir = path.dirname(configPath);
    return {
      ok: false,
      reason: 'Codex config not found',
      hint: `launch Codex once (or \`mkdir -p ${dir} && touch ${configPath}\`) to create the file, then re-run`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(currentText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `${configPath} is not valid TOML`,
      hint: `open ${configPath} and fix the syntax error (${detail}), then re-run`,
    };
  }

  const serversRaw = parsed[MCP_SERVERS_KEY];
  const serversAbsent = serversRaw === undefined;
  if (
    !serversAbsent &&
    (serversRaw === null || typeof serversRaw !== 'object' || Array.isArray(serversRaw))
  ) {
    return {
      ok: false,
      reason: `${configPath} mcp_servers is not a TOML table`,
      hint: `open ${configPath} and remove the \`mcp_servers = ...\` line so we can create the table, then re-run`,
    };
  }
  const existingServers = serversAbsent ? undefined : (serversRaw as Record<string, unknown>);
  const existingToolbox = existingServers?.[TOOLBOX_KEY];

  if (existingToolbox !== undefined) {
    if (toolboxEntryMatches(existingToolbox)) {
      return { ok: true, status: 'already-installed', diff: '' };
    }
    if (!opts.force) {
      return {
        ok: false,
        reason: 'mcp_servers.toolbox already present with different command/args',
        hint: 're-run with --force to overwrite (use --dry-run --force to preview)',
      };
    }
  }

  const mergedServers: Record<string, unknown> = { ...(existingServers ?? {}) };
  mergedServers[TOOLBOX_KEY] = { ...TOOLBOX_ENTRY, args: [...TOOLBOX_ENTRY.args] };
  const merged: Record<string, unknown> = { ...parsed, [MCP_SERVERS_KEY]: mergedServers };

  const nextContent = stringifyToml(merged) + '\n';
  const diff = formatDiff(existingToolbox, mergedServers[TOOLBOX_KEY]);
  return { ok: true, status: 'installed', nextContent, diff };
}

function toolboxEntryMatches(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.command !== TOOLBOX_ENTRY.command) return false;
  if (!Array.isArray(candidate.args)) return false;
  if (candidate.args.length !== TOOLBOX_ENTRY.args.length) return false;
  for (let i = 0; i < TOOLBOX_ENTRY.args.length; i++) {
    if (candidate.args[i] !== TOOLBOX_ENTRY.args[i]) return false;
  }
  return true;
}

function formatDiff(previous: unknown, next: unknown): string {
  const lines: string[] = [];
  if (previous !== undefined) {
    appendTomlTable(lines, '-', previous);
  }
  appendTomlTable(lines, '+', next);
  return lines.join('\n');
}

/**
 * Emits a TOML-shaped block prefixed with `-` or `+` so the dry-run diff
 * mirrors what the user would actually see in `~/.codex/config.toml`. The
 * previous JSON-shaped output mixed TOML dotted keys with JSON values, which
 * was misleading for copy/paste.
 */
function appendTomlTable(lines: string[], prefix: '-' | '+', value: unknown): void {
  lines.push(`${prefix} [${MCP_SERVERS_KEY}.${TOOLBOX_KEY}]`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    lines.push(`${prefix}   <invalid entry: ${JSON.stringify(value)}>`);
    return;
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    lines.push(`${prefix}   ${key} = ${formatTomlValue(fieldValue)}`);
  }
}

function formatTomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(formatTomlValue).join(', ')}]`;
  }
  return JSON.stringify(value);
}
