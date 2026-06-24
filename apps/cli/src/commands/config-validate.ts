import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  findDuplicateKeys,
  ToolBoxConfigSchema,
  type DuplicateKey,
  type ServerConfig,
  type ToolBoxConfig,
} from '@rjolaverria/toolbox-core';

import {
  defaultServerCommandDeps,
  resolveTargetPath,
  type ServerCommandDeps,
} from './server-shared.js';

interface SchemaIssue {
  readonly path: readonly (string | number | symbol)[];
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly SchemaIssue[];
}

export type IssueCategory =
  | 'json'
  | 'duplicate-name'
  | 'invalid-url'
  | 'missing-env'
  | 'broken-command'
  | 'namespace-collision'
  | 'schema';

export interface ValidationIssue {
  category: IssueCategory;
  pointer: string;
  message: string;
}

export interface ConfigValidateOptions {
  config?: string;
  json?: true;
}

export interface ConfigValidateDeps extends ServerCommandDeps {
  /** Look up an env var; tests stub this. Defaults to process.env. */
  getEnv: (name: string) => string | undefined;
  /**
   * Returns true if the given command resolves to an existing executable.
   * Path-like commands (containing a directory separator) are resolved
   * relative to `cwd` when one is supplied — the same directory the upstream
   * server would be spawned from at runtime — so a `command: "./bin/mcp"`
   * paired with `cwd: "/opt/app"` validates correctly. Bare commands fall
   * through to a PATH lookup. Tests stub this; the default uses fs.
   */
  commandExists: (command: string, cwd: string | undefined) => Promise<boolean>;
}

export function defaultConfigValidateDeps(): ConfigValidateDeps {
  const base = defaultServerCommandDeps();
  return {
    ...base,
    getEnv: (name) => process.env[name],
    commandExists: (command, cwd) => defaultCommandExists(command, cwd),
  };
}

const ENV_PLACEHOLDER_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function escapeJsonPointerSegment(segment: string): string {
  // RFC 6901: `~` must be escaped before `/` so re-escaping is unambiguous.
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerOf(parts: readonly (string | number)[]): string {
  if (parts.length === 0) {
    return '';
  }
  return '/' + parts.map((p) => escapeJsonPointerSegment(String(p))).join('/');
}

function displayPointer(pointer: string): string {
  return pointer.length === 0 ? '<root>' : pointer;
}

function nestedMessages(issue: SchemaIssue): string {
  if (!issue.issues || issue.issues.length === 0) {
    return issue.message;
  }
  return issue.issues.map((inner) => inner.message).join('; ');
}

function classifySchemaIssue(issue: SchemaIssue): IssueCategory {
  const last = issue.path[issue.path.length - 1];
  if (last === 'url') {
    return 'invalid-url';
  }
  const all = `${issue.message} ${nestedMessages(issue)}`;
  if (issue.path[0] === 'servers' && all.includes('__')) {
    return 'namespace-collision';
  }
  if (issue.code === 'invalid_key' && issue.path[0] === 'servers') {
    return 'namespace-collision';
  }
  return 'schema';
}

function formatSchemaIssue(issue: SchemaIssue): ValidationIssue {
  const message =
    issue.issues && issue.issues.length > 0
      ? `${issue.message}: ${nestedMessages(issue)}`
      : issue.message;
  return {
    category: classifySchemaIssue(issue),
    pointer: pointerOf(issue.path as readonly (string | number)[]),
    message,
  };
}

function classifyDuplicate(dup: DuplicateKey): IssueCategory {
  if (dup.pointer.startsWith('/servers/')) {
    return 'duplicate-name';
  }
  if (dup.pointer.startsWith('/tools/')) {
    return 'namespace-collision';
  }
  return 'duplicate-name';
}

function formatDuplicate(dup: DuplicateKey): ValidationIssue {
  return {
    category: classifyDuplicate(dup),
    pointer: dup.pointer,
    message: `duplicate JSON key "${dup.key}" at line ${dup.line}, column ${dup.column} (first seen line ${dup.firstSeenLine}, column ${dup.firstSeenColumn})`,
  };
}

function findEnvPlaceholders(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(ENV_PLACEHOLDER_RE)) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

function checkAuthEnv(
  serverName: string,
  entry: ServerConfig,
  deps: ConfigValidateDeps,
  issues: ValidationIssue[],
): void {
  if (entry.type !== 'http' || entry.auth?.type !== 'bearer') {
    return;
  }
  const tokenEnv = entry.auth.tokenEnv;
  if (deps.getEnv(tokenEnv) === undefined) {
    issues.push({
      category: 'missing-env',
      pointer: pointerOf(['servers', serverName, 'auth', 'tokenEnv']),
      message: `environment variable "${tokenEnv}" referenced by auth.tokenEnv is not set`,
    });
  }
}

function checkEnvPlaceholdersIn(
  serverName: string,
  entry: ServerConfig,
  deps: ConfigValidateDeps,
  issues: ValidationIssue[],
): void {
  if (entry.type === 'stdio') {
    if (entry.env === undefined) {
      return;
    }
    for (const [key, value] of Object.entries(entry.env)) {
      for (const varName of findEnvPlaceholders(value)) {
        if (deps.getEnv(varName) === undefined) {
          issues.push({
            category: 'missing-env',
            pointer: pointerOf(['servers', serverName, 'env', key]),
            message: `environment variable "${varName}" referenced by \${env:${varName}} is not set`,
          });
        }
      }
    }
    return;
  }
  if (entry.headers === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(entry.headers)) {
    for (const varName of findEnvPlaceholders(value)) {
      if (deps.getEnv(varName) === undefined) {
        issues.push({
          category: 'missing-env',
          pointer: pointerOf(['servers', serverName, 'headers', key]),
          message: `environment variable "${varName}" referenced by \${env:${varName}} is not set`,
        });
      }
    }
  }
}

async function checkCommand(
  serverName: string,
  entry: ServerConfig,
  deps: ConfigValidateDeps,
  issues: ValidationIssue[],
): Promise<void> {
  if (entry.type !== 'stdio') {
    return;
  }
  const exists = await deps.commandExists(entry.command, entry.cwd);
  if (!exists) {
    issues.push({
      category: 'broken-command',
      pointer: pointerOf(['servers', serverName, 'command']),
      message: `command "${entry.command}" was not found on PATH or is not an executable file`,
    });
  }
}

function checkToolOverrides(config: ToolBoxConfig, issues: ValidationIssue[]): void {
  for (const exposed of Object.keys(config.tools)) {
    const sepIdx = exposed.indexOf('__');
    if (sepIdx <= 0) {
      continue;
    }
    const serverName = exposed.slice(0, sepIdx);
    if (!Object.prototype.hasOwnProperty.call(config.servers, serverName)) {
      issues.push({
        category: 'namespace-collision',
        pointer: pointerOf(['tools', exposed]),
        message: `tool override "${exposed}" references unknown server "${serverName}"`,
      });
    }
  }
}

interface ParseAttempt {
  raw: unknown;
  jsonOk: boolean;
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

function tryParseJson(source: string, issues: ValidationIssue[]): ParseAttempt {
  try {
    return { raw: JSON.parse(source) as unknown, jsonOk: true };
  } catch (error) {
    issues.push({
      category: 'json',
      pointer: '',
      message: error instanceof Error ? error.message : String(error),
    });
    return { raw: undefined, jsonOk: false };
  }
}

export async function collectIssues(
  source: string,
  deps: ConfigValidateDeps,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  for (const dup of findDuplicateKeys(source)) {
    issues.push(formatDuplicate(dup));
  }

  const parsed = tryParseJson(source, issues);
  if (!parsed.jsonOk) {
    return sortIssues(issues);
  }

  const result = ToolBoxConfigSchema.safeParse(parsed.raw);
  if (!result.success) {
    for (const issue of result.error.issues as readonly SchemaIssue[]) {
      issues.push(formatSchemaIssue(issue));
    }
    return sortIssues(issues);
  }

  const config = result.data;
  for (const [name, entry] of Object.entries(config.servers)) {
    checkAuthEnv(name, entry, deps, issues);
    checkEnvPlaceholdersIn(name, entry, deps, issues);
    await checkCommand(name, entry, deps, issues);
  }
  checkToolOverrides(config, issues);

  return sortIssues(issues);
}

function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort((a, b) => {
    if (a.pointer === b.pointer) {
      return a.category.localeCompare(b.category);
    }
    return a.pointer.localeCompare(b.pointer);
  });
}

function formatHuman(target: string, issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) {
    return `Config at ${target} is valid.\n`;
  }
  const lines = [`Config at ${target} has ${issues.length} issue(s):`];
  for (const issue of issues) {
    lines.push(`  [${issue.category}] ${displayPointer(issue.pointer)}: ${issue.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runConfigValidate(
  options: ConfigValidateOptions,
  deps: ConfigValidateDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const source = await readSource(target);
  if (source === null) {
    deps.stderr(`No ToolBox config found at ${target}. Run \`tlbx init\` first.\n`);
    return 1;
  }

  const issues = await collectIssues(source, deps);
  if (options.json === true) {
    deps.stdout(`${JSON.stringify({ path: target, issues }, null, 2)}\n`);
  } else if (issues.length === 0) {
    deps.stdout(formatHuman(target, issues));
  } else {
    deps.stderr(formatHuman(target, issues));
  }
  return issues.length === 0 ? 0 : 1;
}

function executableExtensions(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') {
    return [''];
  }
  // If the user already specified an extension (e.g. `git.exe`), only check
  // the literal command — appending `.EXE`/`.CMD`/etc. would search for
  // `git.exe.EXE` and miss the real binary.
  if (path.extname(command).length > 0) {
    return [''];
  }
  const pathExt = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  return pathExt.split(';').filter((e) => e.length > 0);
}

async function defaultCommandExists(command: string, cwd: string | undefined): Promise<boolean> {
  const platform = process.platform;
  if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) {
    // Resolve relative path-like commands against the server's configured
    // cwd so validation matches the directory the upstream MCP process will
    // be spawned from at runtime. Absolute paths are unaffected.
    const resolved = path.isAbsolute(command)
      ? command
      : path.resolve(cwd ?? process.cwd(), command);
    return isExecutable(resolved, platform);
  }
  const pathEnv = process.env['PATH'] ?? '';
  if (pathEnv.length === 0) {
    return false;
  }
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(sep).filter((d) => d.length > 0);
  const exts = executableExtensions(command, platform);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (await isExecutable(candidate, platform)) {
        return true;
      }
    }
  }
  return false;
}

async function isExecutable(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (platform === 'win32') {
      return true;
    }
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function configValidateCommand(): CommandUnknownOpts {
  return new Command('validate')
    .description('Validate the ToolBox config and print every issue found.')
    .option('--json', 'emit machine-readable JSON instead of human output')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (opts) => {
      const code = await runConfigValidate(opts, defaultConfigValidateDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
