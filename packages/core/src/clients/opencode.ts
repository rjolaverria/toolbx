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

const OPENCODE_CONFIG_REL = path.join('.config', 'opencode', 'opencode.json');
const MCP_KEY = 'mcp';
const TOOLBOX_KEY = 'toolbox';

interface ToolboxEntry {
  type: 'local';
  command: string[];
  enabled: boolean;
}

const TOOLBOX_ENTRY: ToolboxEntry = {
  type: 'local',
  command: ['npx', '-y', 'tlbx', 'serve', '--stdio'],
  enabled: true,
};

export type CreateOpencodeAdapterOptions = ClientAdapterEnv;
export type InternalInstallHooks = InternalInstallFlowHooks;

export function createOpencodeAdapter(options: CreateOpencodeAdapterOptions = {}): ClientAdapter {
  return createOpencodeAdapterInternal(options, {});
}

export function createOpencodeAdapterInternal(
  options: CreateOpencodeAdapterOptions,
  hooks: InternalInstallHooks,
): ClientAdapter {
  const homedir = options.homedir ?? osHomedir;
  const configPath = path.join(homedir(), OPENCODE_CONFIG_REL);

  return {
    name: 'opencode',
    configPath,
    async detect(): Promise<DetectedClient | null> {
      try {
        await fs.stat(configPath);
        return { name: 'opencode', configPath };
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
        merge: ({ currentText, exists }) => mergeOpencodeConfig({ currentText, exists, opts }),
      });
    },
  };
}

export const opencodeAdapter: ClientAdapter = createOpencodeAdapter();

interface MergeInput {
  readonly currentText: string;
  readonly exists: boolean;
  readonly opts: InstallOpts;
}

function mergeOpencodeConfig(input: MergeInput): InstallFlowMergeResult {
  const { currentText, exists, opts } = input;
  if (!exists) {
    return {
      ok: false,
      reason: 'OpenCode config not found',
      hint: 'launch OpenCode once (or `mkdir -p ~/.config/opencode && echo {} > ~/.config/opencode/opencode.json`) to create the file, then re-run',
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(currentText) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        reason: '~/.config/opencode/opencode.json is not a JSON object',
        hint: 'open the file and replace its contents with `{}`, then re-run',
      };
    }
    parsed = raw as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      reason: '~/.config/opencode/opencode.json is not valid JSON',
      hint: 'open the file and fix the syntax error, then re-run',
    };
  }

  const mcpRaw = parsed[MCP_KEY];
  const mcpAbsent = mcpRaw === undefined;
  if (!mcpAbsent && (mcpRaw === null || typeof mcpRaw !== 'object' || Array.isArray(mcpRaw))) {
    return {
      ok: false,
      reason: '~/.config/opencode/opencode.json mcp is not a JSON object',
      hint: 'open the file and replace `mcp` with `{}`, then re-run',
    };
  }
  const existingMcp = mcpAbsent ? undefined : (mcpRaw as Record<string, unknown>);
  const existingToolbox = existingMcp?.[TOOLBOX_KEY];

  if (existingToolbox !== undefined) {
    if (toolboxEntryMatches(existingToolbox)) {
      return { ok: true, status: 'already-installed', diff: '' };
    }
    if (!opts.force) {
      return {
        ok: false,
        reason: 'mcp.toolbox already present with different command/args',
        hint: 're-run with --force to overwrite (use --dry-run --force to preview)',
      };
    }
  }

  const mergedMcp: Record<string, unknown> = { ...(existingMcp ?? {}) };
  mergedMcp[TOOLBOX_KEY] = {
    type: TOOLBOX_ENTRY.type,
    command: [...TOOLBOX_ENTRY.command],
    enabled: TOOLBOX_ENTRY.enabled,
  };
  const merged: Record<string, unknown> = { ...parsed, [MCP_KEY]: mergedMcp };

  const nextContent = JSON.stringify(merged, null, 2) + '\n';
  const diff = formatDiff(existingToolbox, mergedMcp[TOOLBOX_KEY]);
  return { ok: true, status: 'installed', nextContent, diff };
}

function toolboxEntryMatches(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== TOOLBOX_ENTRY.type) return false;
  if (candidate.enabled !== TOOLBOX_ENTRY.enabled) return false;
  if (!Array.isArray(candidate.command)) return false;
  if (candidate.command.length !== TOOLBOX_ENTRY.command.length) return false;
  for (let i = 0; i < TOOLBOX_ENTRY.command.length; i++) {
    if (candidate.command[i] !== TOOLBOX_ENTRY.command[i]) return false;
  }
  return true;
}

function formatDiff(previous: unknown, next: unknown): string {
  const lines: string[] = [];
  if (previous !== undefined) {
    lines.push('- mcp.toolbox = ' + JSON.stringify(previous));
  }
  lines.push('+ mcp.toolbox = ' + JSON.stringify(next));
  return lines.join('\n');
}
