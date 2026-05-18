import * as fs from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import * as path from 'node:path';

import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';

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
const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG';
const MCP_KEY = 'mcp';
const TOOLBOX_KEY = 'toolbox';
const BASE_TOOLBOX_COMMAND: readonly string[] = ['npx', '-y', 'tlbx', 'serve', '--stdio'];

interface ToolboxEntry {
  type: 'local';
  command: string[];
  enabled: boolean;
}

function buildToolboxEntry(extraArgs: readonly string[]): ToolboxEntry {
  return {
    type: 'local',
    command: [...BASE_TOOLBOX_COMMAND, ...extraArgs],
    enabled: true,
  };
}

export interface CreateOpencodeAdapterOptions extends ClientAdapterEnv {
  /**
   * Extra args to append after `npx -y tlbx serve --stdio` in the wired
   * `mcp.toolbox.command` array. `tlbx setup --config <path>` uses this to
   * propagate `['--config', '<absolute path>']` so the gateway opens the
   * same config the user just initialized.
   */
  readonly extraServeArgs?: readonly string[];
}
export type InternalInstallHooks = InternalInstallFlowHooks;

export function createOpencodeAdapter(options: CreateOpencodeAdapterOptions = {}): ClientAdapter {
  return createOpencodeAdapterInternal(options, {});
}

export function createOpencodeAdapterInternal(
  options: CreateOpencodeAdapterOptions,
  hooks: InternalInstallHooks,
): ClientAdapter {
  const homedir = options.homedir ?? osHomedir;
  const env = options.env ?? process.env;
  const configPath = resolveConfigPath(homedir, env);
  const toolboxEntry = buildToolboxEntry(options.extraServeArgs ?? []);

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
        merge: ({ currentText, exists, configPath: resolvedPath }) =>
          mergeOpencodeConfig({
            currentText,
            exists,
            configPath: resolvedPath,
            opts,
            toolboxEntry,
          }),
      });
    },
  };
}

export const opencodeAdapter: ClientAdapter = createOpencodeAdapter();

function resolveConfigPath(homedir: () => string, env: NodeJS.ProcessEnv): string {
  const override = env[OPENCODE_CONFIG_ENV];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return path.join(homedir(), OPENCODE_CONFIG_REL);
}

interface MergeInput {
  readonly currentText: string;
  readonly exists: boolean;
  readonly configPath: string;
  readonly opts: InstallOpts;
  readonly toolboxEntry: ToolboxEntry;
}

function mergeOpencodeConfig(input: MergeInput): InstallFlowMergeResult {
  const { currentText, exists, configPath, opts, toolboxEntry } = input;
  if (!exists) {
    const dir = path.dirname(configPath);
    return {
      ok: false,
      reason: 'OpenCode config not found',
      hint: `launch OpenCode once (or \`mkdir -p ${dir} && echo {} > ${configPath}\`) to create the file, then re-run`,
    };
  }

  // OpenCode supports JSONC (JSON with comments) per its docs. Use jsonc-parser
  // so we tolerate user comments and trailing commas, and so the eventual
  // write uses `modify()`/`applyEdits()` to preserve those comments and the
  // surrounding formatting on disk.
  const parseErrors: Array<{ error: number; offset: number; length: number }> = [];
  const parsed: unknown = parseJsonc(currentText, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const firstParseError = parseErrors[0];
  if (firstParseError !== undefined) {
    const detail = printParseErrorCode(firstParseError.error);
    return {
      ok: false,
      reason: `${configPath} is not valid JSON/JSONC`,
      hint: `open ${configPath} and fix the syntax error (${detail}), then re-run`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `${configPath} is not a JSON object`,
      hint: `open ${configPath} and replace its contents with \`{}\`, then re-run`,
    };
  }
  const parsedObject = parsed as Record<string, unknown>;

  const mcpRaw = parsedObject[MCP_KEY];
  const mcpAbsent = mcpRaw === undefined;
  if (!mcpAbsent && (mcpRaw === null || typeof mcpRaw !== 'object' || Array.isArray(mcpRaw))) {
    return {
      ok: false,
      reason: `${configPath} mcp is not a JSON object`,
      hint: `open ${configPath} and replace \`mcp\` with \`{}\`, then re-run`,
    };
  }
  const existingMcp = mcpAbsent ? undefined : (mcpRaw as Record<string, unknown>);
  const existingToolbox = existingMcp?.[TOOLBOX_KEY];

  if (existingToolbox !== undefined) {
    if (toolboxEntryMatches(existingToolbox, toolboxEntry)) {
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

  // Use jsonc-parser's edit API so user comments and trailing commas survive
  // the rewrite. `modify()` returns a set of text edits that `applyEdits()`
  // applies in place; the result is byte-for-byte equivalent to the original
  // file except for the targeted `mcp.toolbox` slot.
  const nextEntry = {
    type: toolboxEntry.type,
    command: [...toolboxEntry.command],
    enabled: toolboxEntry.enabled,
  };
  const edits = modify(currentText, [MCP_KEY, TOOLBOX_KEY], nextEntry, {
    formattingOptions: { tabSize: 2, insertSpaces: true, eol: detectEol(currentText) },
  });
  const nextContent = applyEdits(currentText, edits);
  const diff = formatDiff(existingToolbox, nextEntry);
  return { ok: true, status: 'installed', nextContent, diff };
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function toolboxEntryMatches(value: unknown, expected: ToolboxEntry): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== expected.type) return false;
  if (candidate.enabled !== expected.enabled) return false;
  if (!Array.isArray(candidate.command)) return false;
  if (candidate.command.length !== expected.command.length) return false;
  for (let i = 0; i < expected.command.length; i++) {
    if (candidate.command[i] !== expected.command[i]) return false;
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
