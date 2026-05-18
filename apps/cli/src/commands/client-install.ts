import * as readline from 'node:readline/promises';

import { Command, InvalidArgumentError } from '@commander-js/extra-typings';

import {
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
  type ClientAdapter,
  type ClientName,
} from '@toolbox/core';

const SUPPORTED: readonly ClientName[] = ['claude', 'codex', 'opencode'];

function isClientName(value: string): value is ClientName {
  return (SUPPORTED as readonly string[]).includes(value);
}

export interface ClientInstallOptions {
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
}

export interface ClientInstallDeps {
  write(msg: string): void;
  writeErr(msg: string): void;
  confirm(prompt: string): Promise<boolean>;
  resolveAdapter(name: ClientName): ClientAdapter | null;
}

export function defaultClientInstallDeps(): ClientInstallDeps {
  return {
    write: (m) => {
      process.stdout.write(m);
    },
    writeErr: (m) => {
      process.stderr.write(m);
    },
    confirm: defaultConfirm,
    resolveAdapter: (name) => {
      switch (name) {
        case 'claude':
          return claudeAdapter;
        case 'codex':
          return codexAdapter;
        case 'opencode':
          return opencodeAdapter;
      }
    },
  };
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function runClientInstall(
  rawClient: string,
  options: ClientInstallOptions,
  deps: ClientInstallDeps,
): Promise<number> {
  if (!isClientName(rawClient)) {
    deps.writeErr(`Unknown client "${rawClient}". Supported clients: ${SUPPORTED.join(', ')}.\n`);
    return 1;
  }
  const adapter = deps.resolveAdapter(rawClient);
  if (!adapter) {
    deps.writeErr(`No adapter registered for "${rawClient}".\n`);
    return 1;
  }

  const detected = await adapter.detect();
  if (!detected) {
    deps.writeErr(
      `${rawClient}: not detected. Launch ${rawClient} once to create its config, then re-run.\n`,
    );
    return 1;
  }

  const preview = await adapter.install({ dryRun: true, force: options.force });
  if (!preview.ok) {
    deps.writeErr(`${rawClient}: ${preview.reason}\n`);
    if (preview.hint !== undefined) {
      deps.writeErr(`hint: ${preview.hint}\n`);
    }
    return 1;
  }
  if (preview.status === 'already-installed') {
    deps.write(`already wired into ${rawClient} (${preview.configPath}); no changes.\n`);
    return 0;
  }

  deps.write(`Planned change to ${preview.configPath}:\n${preview.diff}\n`);

  if (options.dryRun) {
    return 0;
  }

  if (!options.yes) {
    const confirmed = await deps.confirm(`Apply this change? [y/N] `);
    if (!confirmed) {
      deps.writeErr('aborted by user; no changes written.\n');
      return 1;
    }
  }

  const applied = await adapter.install({ dryRun: false, force: options.force });
  if (!applied.ok) {
    deps.writeErr(`${rawClient}: ${applied.reason}\n`);
    if (applied.hint !== undefined) {
      deps.writeErr(`hint: ${applied.hint}\n`);
    }
    return 1;
  }

  deps.write(`Wrote ${applied.configPath}\n`);
  if (applied.backupPath !== undefined) {
    deps.write(`backup at ${applied.backupPath}\n`);
  }
  deps.write(`Restart ${rawClient} to pick up the change.\n`);
  return 0;
}

function parseClient(value: string): string {
  if (!isClientName(value)) {
    throw new InvalidArgumentError(
      `unknown client "${value}". Supported: ${SUPPORTED.join(', ')}.`,
    );
  }
  return value;
}

/**
 * Attaches the `install` subcommand to the provided `client` group.
 *
 * Implemented as a side-effect on the parent (rather than returning a fresh
 * Command) so it composes with the typed-arg Commander API the rest of the
 * CLI uses — `addCommand(Command<[string]>)` doesn't satisfy the no-arg
 * shape `Command<[]>` that `extra-typings` infers for `addCommand`.
 */
export function registerClientInstall(parent: Command): void {
  parent
    .command('install')
    .description('Install the ToolBox MCP entry into the chosen client config file.')
    .argument('<client>', `target client (${SUPPORTED.join(' | ')})`, parseClient)
    .option('-y, --yes', 'skip the confirmation prompt', false)
    .option('--dry-run', 'print the diff and exit without writing', false)
    .option('--force', 'overwrite a conflicting toolbox entry (still creates a backup)', false)
    .action(async (client, opts) => {
      const options: ClientInstallOptions = {
        yes: opts.yes === true,
        dryRun: opts.dryRun === true,
        force: opts.force === true,
      };
      const code = await runClientInstall(client, options, defaultClientInstallDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
