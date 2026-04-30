import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { saveConfig, type ServerConfig, type ToolboxConfig } from '@toolbox/core';

import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  requireExistingServer,
  resolveTargetPath,
  validateNextConfig,
  type ServerCommandDeps,
} from './server-shared.js';

export interface EditOptions {
  config?: string;
  editor?: string;
}

export interface EditorExit {
  /** Exit code reported by the child process, or null if the child was killed by a signal. */
  code: number | null;
  /** Signal that terminated the child, or null if it exited normally. */
  signal: NodeJS.Signals | null;
}

export interface EditDeps extends ServerCommandDeps {
  /** Resolves the editor command. Tests stub this; default reads $EDITOR or 'vi'. */
  resolveEditor: () => string;
  /** Spawns the editor on the given file path; resolves with how the child exited. */
  spawnEditor: (editor: string, file: string) => Promise<EditorExit>;
  /** Returns a unique temp file path. Tests stub this for determinism. */
  tempFilePath: (name: string) => string;
}

/**
 * Split an editor command string into argv tokens so values like
 * `EDITOR="code --wait"` work the same as a bare `vi`. Whitespace-split is
 * sufficient for the cases that actually appear in $EDITOR — editor args with
 * embedded spaces or shell metacharacters are vanishingly rare and the costs
 * of a full shell parser outweigh the benefit.
 */
export function splitEditorCommand(editor: string): { command: string; args: string[] } {
  const tokens = editor
    .trim()
    .split(/\s+/u)
    .filter((t) => t.length > 0);
  const [command, ...args] = tokens;
  if (command === undefined) {
    throw new Error('editor command is empty');
  }
  return { command, args };
}

export function defaultEditDeps(): EditDeps {
  const base = defaultServerCommandDeps();
  return {
    ...base,
    resolveEditor: () => process.env['EDITOR'] ?? 'vi',
    spawnEditor: (editor, file) =>
      new Promise<EditorExit>((resolve, reject) => {
        const { command, args } = splitEditorCommand(editor);
        const child = spawn(command, [...args, file], { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
          resolve({ code, signal });
        });
      }),
    tempFilePath: (name) => path.join(os.tmpdir(), `toolbox-server-${name}-${randomUUID()}.json`),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function runServerEdit(
  name: string,
  options: EditOptions,
  deps: EditDeps,
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

  const editor = options.editor ?? deps.resolveEditor();
  const tempFile = deps.tempFilePath(name);

  await fs.writeFile(tempFile, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });

  try {
    let exit: EditorExit;
    try {
      exit = await deps.spawnEditor(editor, tempFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.stderr(`Failed to launch editor "${editor}": ${message}\n`);
      return 1;
    }
    if (exit.signal !== null) {
      deps.stderr(`Editor was terminated by ${exit.signal}. Aborting; config not changed.\n`);
      return 1;
    }
    if (exit.code !== 0) {
      deps.stderr(
        `Editor exited with code ${exit.code ?? 'unknown'}. Aborting; config not changed.\n`,
      );
      return 1;
    }

    const raw = await fs.readFile(tempFile, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.stderr(`Invalid JSON: ${message}\n`);
      return 1;
    }

    if (!isPlainObject(parsed)) {
      deps.stderr('Edited content must be a JSON object representing the server entry.\n');
      return 1;
    }

    const candidate: ToolboxConfig = {
      ...config,
      servers: { ...config.servers, [name]: parsed as ServerConfig },
    };
    const validated = validateNextConfig(candidate, target, deps);
    if (!validated.ok) {
      return 1;
    }

    await saveConfig(validated.next, target);
    const updated = validated.next.servers[name];
    deps.stdout(`${JSON.stringify(updated, null, 2)}\n`);
    return 0;
  } finally {
    await fs.unlink(tempFile).catch(() => undefined);
  }
}

export function editCommand(): CommandUnknownOpts {
  return new Command('edit')
    .description('Open the server entry in $EDITOR; validate and save on exit.')
    .argument('<name>', 'server name')
    .option('--editor <command>', 'override the editor command (defaults to $EDITOR or vi)')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (name, opts) => {
      const code = await runServerEdit(name, opts, defaultEditDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
