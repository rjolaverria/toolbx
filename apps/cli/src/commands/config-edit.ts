import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  ConfigLoadError,
  ConfigValidationError,
  DuplicateKeyError,
  parseConfig,
  saveConfig,
  withConfigLock,
  type ToolbxConfig,
} from '@toolbx/core';

import { splitEditorCommand, type EditorExit } from './server-edit.js';
import {
  defaultServerCommandDeps,
  resolveTargetPath,
  type ServerCommandDeps,
} from './server-shared.js';

export interface ConfigEditOptions {
  config?: string;
  editor?: string;
}

export interface ConfigEditDeps extends ServerCommandDeps {
  resolveEditor: () => string;
  spawnEditor: (editor: string, file: string) => Promise<EditorExit>;
  tempFilePath: () => string;
  platform: () => NodeJS.Platform;
}

export function defaultConfigEditDeps(): ConfigEditDeps {
  const base = defaultServerCommandDeps();
  return {
    ...base,
    resolveEditor: () => process.env['EDITOR'] ?? (process.platform === 'win32' ? 'notepad' : 'vi'),
    spawnEditor: (editor, file) =>
      new Promise<EditorExit>((resolve, reject) => {
        const { command, args } = splitEditorCommand(editor);
        const child = spawn(command, [...args, file], { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
          resolve({ code, signal });
        });
      }),
    tempFilePath: () => path.join(os.tmpdir(), `toolbx-config-${randomUUID()}.json`),
    platform: () => process.platform,
  };
}

async function readSource(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function reportParseError(error: unknown, deps: ConfigEditDeps): void {
  if (error instanceof ConfigValidationError || error instanceof DuplicateKeyError) {
    deps.stderr(`${error.message}\n`);
    return;
  }
  if (error instanceof ConfigLoadError) {
    deps.stderr(`${error.message}\n`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  deps.stderr(`${message}\n`);
}

export async function runConfigEdit(
  options: ConfigEditOptions,
  deps: ConfigEditDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const source = await readSource(target);
  if (source === null) {
    deps.stderr(`No Toolbx config found at ${target}. Run \`tlbx init\` first.\n`);
    return 1;
  }

  const editor = options.editor ?? deps.resolveEditor();
  const tempFile = deps.tempFilePath();
  await fs.writeFile(tempFile, source, { mode: 0o600 });

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

    const edited = await fs.readFile(tempFile, 'utf8');
    if (edited === source) {
      deps.stdout(`No changes; config left untouched at ${target}.\n`);
      return 0;
    }

    let validated: ToolbxConfig;
    try {
      validated = parseConfig(edited, target);
    } catch (error) {
      reportParseError(error, deps);
      deps.stderr('Refusing to save: config remained unchanged.\n');
      return 1;
    }

    // The editor edits the whole file, so concurrent locked changes can't be
    // auto-merged. Under the shared lock, confirm the on-disk config still
    // matches the snapshot opened in the editor; if a concurrent command changed
    // it meanwhile, refuse rather than clobber that change (P3-07).
    return withConfigLock(path.dirname(target), async () => {
      const onDisk = await readSource(target);
      if (onDisk !== source) {
        deps.stderr(
          `Config at ${target} changed on disk while the editor was open; ` +
            `your edits were not saved to avoid clobbering that change. ` +
            `Re-run \`tlbx config edit\`.\n`,
        );
        return 1;
      }
      await saveConfig(validated, target);
      deps.stdout(`Saved config to ${target}.\n`);
      return 0;
    });
  } finally {
    await fs.unlink(tempFile).catch(() => undefined);
  }
}

export function configEditCommand(): CommandUnknownOpts {
  return new Command('edit')
    .description('Open the Toolbx config in $EDITOR; validate and save on exit.')
    .option('--editor <command>', 'override the editor command (defaults to $EDITOR or vi)')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (opts) => {
      const code = await runConfigEdit(opts, defaultConfigEditDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
