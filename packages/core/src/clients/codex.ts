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
        merge: ({ currentText, exists }) => mergeCodexConfig({ currentText, exists, opts }),
      });
    },
  };
}

export const codexAdapter: ClientAdapter = createCodexAdapter();

interface MergeInput {
  readonly currentText: string;
  readonly exists: boolean;
  readonly opts: InstallOpts;
}

function mergeCodexConfig(input: MergeInput): InstallFlowMergeResult {
  const { currentText, exists, opts } = input;
  if (!exists) {
    return {
      ok: false,
      reason: 'Codex config not found',
      hint: 'launch Codex once (or `mkdir -p ~/.codex && touch ~/.codex/config.toml`) to create the file, then re-run',
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(currentText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: '~/.codex/config.toml is not valid TOML',
      hint: `open ~/.codex/config.toml and fix the syntax error (${detail}), then re-run`,
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
      reason: '~/.codex/config.toml mcp_servers is not a TOML table',
      hint: 'open ~/.codex/config.toml and remove the `mcp_servers = ...` line so we can create the table, then re-run',
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
        hint: 're-run with --force to overwrite (use dryRun + force to preview)',
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
    lines.push('- mcp_servers.toolbox = ' + JSON.stringify(previous));
  }
  lines.push('+ mcp_servers.toolbox = ' + JSON.stringify(next));
  return lines.join('\n');
}
