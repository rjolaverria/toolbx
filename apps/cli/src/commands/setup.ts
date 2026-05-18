import * as readline from 'node:readline/promises';

import { Command, InvalidArgumentError } from '@commander-js/extra-typings';
import {
  createClaudeAdapter,
  createCodexAdapter,
  createOpencodeAdapter,
  detectClients,
  resolveConfigPath,
  ServerNameSchema,
  type ClientAdapter,
  type ClientAdapterEnv,
  type ClientName,
  type DetectedClient,
  type InstallResult,
} from '@toolbox/core';

import { createConfigIfMissing } from './init.js';
import { runAddStdio, type ServerAddDeps } from './server-add.js';

const SUPPORTED_CLIENTS: readonly ClientName[] = ['claude', 'codex', 'opencode'];

const DISPLAY_NAMES: Readonly<Record<ClientName, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

function isClientName(value: string): value is ClientName {
  return (SUPPORTED_CLIENTS as readonly string[]).includes(value);
}

export interface Prompter {
  prompt(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

export interface SetupOptions {
  readonly yes: boolean;
  readonly noServer: boolean;
  readonly clients: readonly string[] | undefined;
  readonly transport: string | undefined;
  readonly config: string | undefined;
}

export interface SetupDeps {
  write(msg: string): void;
  writeErr(msg: string): void;
  prompter: Prompter;
  resolveConfigPath(): string;
  cwd(): string;
  detectClients(): Promise<readonly DetectedClient[]>;
  resolveAdapter(name: ClientName): ClientAdapter | null;
}

export interface DefaultSetupDepsOptions {
  env?: ClientAdapterEnv;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  prompter?: Prompter;
  resolveConfigPath?: () => string;
  cwd?: () => string;
}

export function defaultSetupDeps(opts: DefaultSetupDepsOptions = {}): SetupDeps {
  const env = opts.env ?? {};
  const stdout =
    opts.stdout ??
    ((m: string): void => {
      process.stdout.write(m);
    });
  const stderr =
    opts.stderr ??
    ((m: string): void => {
      process.stderr.write(m);
    });
  const prompter = opts.prompter ?? defaultPrompter();
  return {
    write: stdout,
    writeErr: stderr,
    prompter,
    resolveConfigPath: opts.resolveConfigPath ?? ((): string => resolveConfigPath()),
    cwd: opts.cwd ?? ((): string => process.cwd()),
    detectClients: () => detectClients(env),
    resolveAdapter: (name): ClientAdapter => {
      switch (name) {
        case 'claude':
          return createClaudeAdapter(env);
        case 'codex':
          return createCodexAdapter(env);
        case 'opencode':
          return createOpencodeAdapter(env);
      }
    },
  };
}

function defaultPrompter(): Prompter {
  return {
    async prompt(question: string): Promise<string> {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    async confirm(question: string): Promise<boolean> {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(question)).trim().toLowerCase();
        // [Y/n] convention: empty answer means accept.
        return answer === '' || answer === 'y' || answer === 'yes';
      } finally {
        rl.close();
      }
    },
  };
}

export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<number> {
  if (options.transport === 'http') {
    deps.writeErr(
      '--transport http is not yet supported in v1. Use stdio (default) or run `tlbx serve` manually.\n',
    );
    return 1;
  }

  const requestedClients = parseRequestedClients(options.clients, deps);
  if (requestedClients === null) {
    return 1;
  }

  const target =
    options.config !== undefined && options.config.length > 0
      ? options.config
      : deps.resolveConfigPath();

  let configCreated: boolean;
  try {
    const result = await createConfigIfMissing(target);
    configCreated = result.created;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.writeErr(`Failed to create config at ${target}: ${message}\n`);
    return 1;
  }
  if (configCreated) {
    deps.write(`✓ Created config at ${target}\n`);
  } else {
    deps.write(`✓ Config already exists at ${target}\n`);
  }

  const allDetected = await deps.detectClients();
  const detected = filterDetected(allDetected, requestedClients);

  if (detected.length === 0) {
    if (requestedClients !== null && requestedClients.length > 0) {
      deps.write(
        `No requested MCP clients are detected (${requestedClients.join(', ')}). Launch the client once to create its config, then run \`tlbx client install <client>\`.\n`,
      );
    } else {
      deps.write(
        'No MCP clients detected — you can wire one up later with `tlbx client install <client>`.\n',
      );
    }
  } else {
    deps.write('Detected MCP clients:\n');
    for (const client of detected) {
      deps.write(`  • ${DISPLAY_NAMES[client.name]}  (${client.configPath})\n`);
    }
  }

  let serverAddFailed = false;
  if (!options.noServer) {
    if (options.yes) {
      deps.write('Add an upstream MCP server later with: tlbx server add-stdio <name> -- <cmd>\n');
    } else {
      const outcome = await promptForServer(target, deps);
      if (outcome === 'failed') {
        serverAddFailed = true;
      }
    }
  }

  const installResults = await applyClientInstalls(detected, options, deps);

  printSummary(installResults, deps);

  // A failed interactive server-add is a direct user-requested step that did
  // not complete, so it dominates the exit code regardless of client wiring
  // outcomes. Client-install failures still fall through to the existing
  // "every step failed" rule below.
  if (serverAddFailed) {
    return 1;
  }
  if (installResults.failures > 0 && installResults.successes === 0) {
    return 1;
  }
  return 0;
}

interface InstallSummary {
  successes: number;
  failures: number;
  /** Display names of clients we just wrote to (i.e. they need a restart). */
  written: string[];
  /** Display names of clients that were already wired before this run. */
  alreadyWired: string[];
}

async function applyClientInstalls(
  detected: readonly DetectedClient[],
  options: SetupOptions,
  deps: SetupDeps,
): Promise<InstallSummary> {
  const summary: InstallSummary = {
    successes: 0,
    failures: 0,
    written: [],
    alreadyWired: [],
  };
  if (detected.length === 0) {
    return summary;
  }

  interface Pending {
    readonly client: DetectedClient;
    readonly adapter: ClientAdapter;
    readonly preview: InstallResult;
  }
  const pending: Pending[] = [];

  for (const client of detected) {
    const adapter = deps.resolveAdapter(client.name);
    if (!adapter) {
      continue;
    }
    const displayName = DISPLAY_NAMES[client.name];
    deps.write(`\n${displayName}:\n`);
    const preview = await adapter.install({ dryRun: true, force: false });
    if (!preview.ok) {
      deps.writeErr(`  ✗ ${displayName}: ${preview.reason}\n`);
      if (preview.hint !== undefined) {
        deps.writeErr(`    hint: ${preview.hint}\n`);
      }
      summary.failures += 1;
      continue;
    }
    if (preview.status === 'already-installed') {
      deps.write(`  already wired (${preview.configPath}); no changes.\n`);
      summary.alreadyWired.push(displayName);
      summary.successes += 1;
      continue;
    }
    deps.write(indentLines(preview.diff, '  ') + '\n');
    pending.push({ client, adapter, preview });
  }

  if (pending.length === 0) {
    return summary;
  }

  let proceed = options.yes;
  if (!proceed) {
    const names = pending.map((p) => DISPLAY_NAMES[p.client.name]).join(', ');
    proceed = await deps.prompter.confirm(`\nWire ToolBox into ${names}? [Y/n] `);
  }
  if (!proceed) {
    deps.write(
      '\nskipped client install; rerun `tlbx setup` later or use `tlbx client install <client>`.\n',
    );
    return summary;
  }

  for (const item of pending) {
    const displayName = DISPLAY_NAMES[item.client.name];
    const applied = await item.adapter.install({ dryRun: false, force: false });
    if (!applied.ok) {
      deps.writeErr(`  ✗ ${displayName}: ${applied.reason}\n`);
      if (applied.hint !== undefined) {
        deps.writeErr(`    hint: ${applied.hint}\n`);
      }
      summary.failures += 1;
      continue;
    }
    summary.successes += 1;
    if (applied.status === 'already-installed') {
      deps.write(`  ✓ ${displayName}: already wired (no changes)\n`);
      summary.alreadyWired.push(displayName);
      continue;
    }
    let line = `  ✓ ${displayName}: wrote ${applied.configPath}`;
    if (applied.backupPath !== undefined) {
      line += ` (backup ${applied.backupPath})`;
    }
    deps.write(line + '\n');
    summary.written.push(displayName);
  }
  return summary;
}

function printSummary(summary: InstallSummary, deps: SetupDeps): void {
  if (summary.written.length > 0) {
    deps.write(`\n✓ All set. Restart ${summary.written.join(', ')} to pick up the new server.\n`);
  } else {
    deps.write('\n✓ All set.\n');
  }
  deps.write('Add more upstream servers anytime:  tlbx server add-stdio <name> -- <cmd>\n');
}

function filterDetected(
  detected: readonly DetectedClient[],
  requested: readonly ClientName[] | null,
): readonly DetectedClient[] {
  if (requested === null || requested.length === 0) {
    return detected;
  }
  const set = new Set<ClientName>(requested);
  return detected.filter((c) => set.has(c.name));
}

function parseRequestedClients(
  raw: readonly string[] | undefined,
  deps: SetupDeps,
): readonly ClientName[] | null {
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  const out: ClientName[] = [];
  for (const value of raw) {
    if (!isClientName(value)) {
      deps.writeErr(
        `Unknown client "${value}". Supported clients: ${SUPPORTED_CLIENTS.join(', ')}.\n`,
      );
      return null;
    }
    out.push(value);
  }
  return out;
}

function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

/**
 * Minimal POSIX-shell-style tokenizer for the interactive `Command:` prompt.
 *
 * Splits on whitespace but honors single quotes (literal), double quotes
 * (with `\\\"` and `\\\\` escapes), and backslash as a one-character escape
 * outside quotes. Throws on unterminated quotes so the caller can ask the
 * user to retype instead of silently merging tokens.
 *
 * We accept the smaller surface area instead of pulling in `shell-quote`
 * because we only need it in this one prompt path and the rules we care
 * about (paths with spaces, no env expansion, no globbing) fit in ~30 lines.
 */
export function parseShellCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let collecting = false;
  let mode: 'normal' | 'single' | 'double' = 'normal';

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (mode === 'normal') {
      if (ch === ' ' || ch === '\t') {
        if (collecting) {
          tokens.push(current);
          current = '';
          collecting = false;
        }
        continue;
      }
      if (ch === "'") {
        mode = 'single';
        collecting = true;
        continue;
      }
      if (ch === '"') {
        mode = 'double';
        collecting = true;
        continue;
      }
      if (ch === '\\' && i + 1 < input.length) {
        current += input[i + 1];
        collecting = true;
        i += 1;
        continue;
      }
      current += ch;
      collecting = true;
      continue;
    }
    if (mode === 'single') {
      if (ch === "'") {
        mode = 'normal';
        continue;
      }
      current += ch;
      continue;
    }
    // mode === 'double'
    if (ch === '"') {
      mode = 'normal';
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      const next = input[i + 1];
      if (next === '"' || next === '\\') {
        current += next;
        i += 1;
        continue;
      }
    }
    current += ch;
  }

  if (mode !== 'normal') {
    throw new Error(
      mode === 'single' ? 'unterminated single-quoted string' : 'unterminated double-quoted string',
    );
  }
  if (collecting) {
    tokens.push(current);
  }
  return tokens;
}

type ServerPromptOutcome = 'skipped' | 'added' | 'failed';

async function promptForServer(target: string, deps: SetupDeps): Promise<ServerPromptOutcome> {
  const wantsServer = await deps.prompter.confirm('\nAdd an upstream MCP server now? [Y/n] ');
  if (!wantsServer) {
    return 'skipped';
  }

  const name = await promptUntilValidName(deps);
  if (name === null) {
    return 'failed';
  }

  const commandLine = (
    await deps.prompter.prompt('Command (supports POSIX-style quotes for paths with spaces): ')
  ).trim();
  if (commandLine.length === 0) {
    deps.writeErr('Empty command; skipping server addition.\n');
    return 'failed';
  }
  let tokens: string[];
  try {
    tokens = parseShellCommand(commandLine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.writeErr(`Could not parse command: ${message}. Skipping server addition.\n`);
    return 'failed';
  }
  if (tokens.length === 0) {
    deps.writeErr('Empty command; skipping server addition.\n');
    return 'failed';
  }

  const envEntries: string[] = [];
  let first = true;
  for (;;) {
    const label = first ? 'Env var (KEY=VALUE, blank to finish): ' : 'Env var: ';
    first = false;
    const entry = (await deps.prompter.prompt(label)).trim();
    if (entry.length === 0) {
      break;
    }
    if (!/^[^=]+=/.test(entry)) {
      deps.writeErr(`Invalid env entry "${entry}". Expected KEY=VALUE; skipping it.\n`);
      continue;
    }
    envEntries.push(entry);
  }

  const serverDeps: ServerAddDeps = {
    resolvePath: () => target,
    cwd: () => deps.cwd(),
    stdout: (m: string) => {
      deps.write(m);
    },
    stderr: (m: string) => {
      deps.writeErr(m);
    },
  };
  const addOptions = envEntries.length > 0 ? { env: envEntries } : {};
  const exitCode = await runAddStdio(name, tokens, addOptions, serverDeps);
  return exitCode === 0 ? 'added' : 'failed';
}

async function promptUntilValidName(deps: SetupDeps): Promise<string | null> {
  // Bound the retries so a misbehaving non-interactive stdin can't spin forever.
  // Three tries matches typical CLI re-entry UX and keeps tests deterministic.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = (await deps.prompter.prompt('Name: ')).trim();
    const result = ServerNameSchema.safeParse(raw);
    if (result.success) {
      return result.data;
    }
    const message = result.error.issues[0]?.message ?? 'invalid server name';
    deps.writeErr(`Invalid server name "${raw}": ${message}\n`);
  }
  deps.writeErr('Too many invalid server names; skipping server addition.\n');
  return null;
}

function collectClient(value: string, previous: readonly string[] | undefined): readonly string[] {
  if (!isClientName(value)) {
    throw new InvalidArgumentError(
      `unknown client "${value}". Supported: ${SUPPORTED_CLIENTS.join(', ')}.`,
    );
  }
  return previous === undefined ? [value] : [...previous, value];
}

export function setupCommand(): Command {
  return new Command('setup')
    .description(
      'One-shot first-run setup: create the ToolBox config, optionally add an upstream server, and wire detected MCP clients (Claude Code, Codex, OpenCode).',
    )
    .option('-y, --yes', 'skip all confirmation prompts', false)
    .option(
      '--client <name>',
      'limit client wiring to the named client (repeatable)',
      collectClient,
    )
    .option('--no-server', 'skip the upstream-server prompt entirely')
    .option('--transport <transport>', 'reserved; only stdio is supported in v1')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (opts) => {
      const options: SetupOptions = {
        yes: opts.yes === true,
        noServer: opts.server === false,
        clients: opts.client,
        transport: opts.transport,
        config: opts.config,
      };
      const code = await runSetup(options, defaultSetupDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
