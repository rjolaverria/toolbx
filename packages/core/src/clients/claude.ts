import * as fs from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import * as path from 'node:path';

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

const CLAUDE_CONFIG_FILENAME = '.claude.json';
const TOOLBOX_KEY = 'toolbox';

interface ToolboxEntry {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

const TOOLBOX_ENTRY: ToolboxEntry = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'tlbx', 'serve', '--stdio'],
  env: {},
};

export type CreateClaudeAdapterOptions = ClientAdapterEnv;

/**
 * Hooks reserved for tests inside this module. Re-exported as
 * {@link InternalInstallHooks} for backwards compatibility with the F1-08
 * test surface.
 */
export type InternalInstallHooks = InternalInstallFlowHooks;

export function createClaudeAdapter(options: CreateClaudeAdapterOptions = {}): ClientAdapter {
  return createClaudeAdapterInternal(options, {});
}

export function createClaudeAdapterInternal(
  options: CreateClaudeAdapterOptions,
  hooks: InternalInstallHooks,
): ClientAdapter {
  const homedir = options.homedir ?? osHomedir;
  const configPath = resolveConfigPath(homedir);

  return {
    name: 'claude',
    async detect(): Promise<DetectedClient | null> {
      try {
        await fs.stat(configPath);
        return { name: 'claude', configPath };
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
        merge: ({ currentText, exists }) => mergeClaudeConfig({ currentText, exists, opts }),
      });
    },
  };
}

export const claudeAdapter: ClientAdapter = createClaudeAdapter();

function resolveConfigPath(homedir: () => string): string {
  return path.join(homedir(), CLAUDE_CONFIG_FILENAME);
}

interface MergeInput {
  readonly currentText: string;
  readonly exists: boolean;
  readonly opts: InstallOpts;
}

function mergeClaudeConfig(input: MergeInput): InstallFlowMergeResult {
  const { currentText, exists, opts } = input;
  if (!exists) {
    return {
      ok: false,
      reason: 'Claude Code config not found',
      hint: 'launch Claude Code once to create ~/.claude.json, then re-run',
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(currentText) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        reason: '~/.claude.json is not a JSON object',
        hint: 'open ~/.claude.json and replace the file contents with `{}`, then re-run',
      };
    }
    parsed = raw as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      reason: '~/.claude.json is not valid JSON',
      hint: 'open ~/.claude.json and fix the syntax error, then re-run',
    };
  }

  // Reject (rather than silently overwrite) an mcpServers value that exists
  // but is the wrong shape. `mcpServers: null` is treated as malformed
  // (not "absent") because the key was deliberately set to a non-object value.
  const mcpServersRaw = parsed.mcpServers;
  const mcpServersAbsent = mcpServersRaw === undefined;
  if (
    !mcpServersAbsent &&
    (mcpServersRaw === null || typeof mcpServersRaw !== 'object' || Array.isArray(mcpServersRaw))
  ) {
    return {
      ok: false,
      reason: '~/.claude.json mcpServers is not a JSON object',
      hint: 'open ~/.claude.json and replace mcpServers with `{}`, then re-run',
    };
  }
  const existingServers = mcpServersAbsent ? undefined : (mcpServersRaw as Record<string, unknown>);
  const existingToolbox = existingServers?.[TOOLBOX_KEY];

  if (existingToolbox !== undefined) {
    if (toolboxEntryMatches(existingToolbox)) {
      return { ok: true, status: 'already-installed', diff: '' };
    }
    if (!opts.force) {
      return {
        ok: false,
        reason: 'mcpServers.toolbox already present with different command/args',
        hint: 're-run with --force to overwrite (use dryRun + force to preview)',
      };
    }
  }

  const merged: Record<string, unknown> = { ...parsed };
  const mergedServers: Record<string, unknown> = { ...(existingServers ?? {}) };
  mergedServers[TOOLBOX_KEY] = { ...TOOLBOX_ENTRY, args: [...TOOLBOX_ENTRY.args] };
  merged.mcpServers = mergedServers;

  const nextContent = JSON.stringify(merged, null, 2) + '\n';
  const diff = formatDiff(existingToolbox, mergedServers[TOOLBOX_KEY]);
  return { ok: true, status: 'installed', nextContent, diff };
}

function toolboxEntryMatches(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== TOOLBOX_ENTRY.type) return false;
  if (candidate.command !== TOOLBOX_ENTRY.command) return false;
  if (!arraysShallowEqual(candidate.args, TOOLBOX_ENTRY.args)) return false;
  if (!recordsShallowEqual(candidate.env, TOOLBOX_ENTRY.env)) return false;
  return true;
}

function arraysShallowEqual(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function recordsShallowEqual(a: unknown, b: Readonly<Record<string, string>>): boolean {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return false;
  const candidate = a as Record<string, unknown>;
  const aKeys = Object.keys(candidate);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of bKeys) {
    if (candidate[key] !== b[key]) return false;
  }
  return true;
}

function formatDiff(previous: unknown, next: unknown): string {
  const before = previous === undefined ? null : previous;
  const lines: string[] = [];
  if (before !== null) {
    lines.push('- mcpServers.toolbox = ' + JSON.stringify(before));
  }
  lines.push('+ mcpServers.toolbox = ' + JSON.stringify(next));
  return lines.join('\n');
}
