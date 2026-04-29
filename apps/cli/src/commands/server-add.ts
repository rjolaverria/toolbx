import * as path from 'node:path';

import {
  Command,
  InvalidArgumentError,
  Option,
  type CommandUnknownOpts,
} from '@commander-js/extra-typings';
import {
  ConfigLoadError,
  ConfigValidationError,
  loadConfig,
  resolveConfigPath,
  saveConfig,
  ToolboxConfigSchema,
  type HttpServerConfig,
  type StdioServerConfig,
  type ToolboxConfig,
} from '@toolbox/core';

export interface ServerAddDeps {
  resolvePath: () => string;
  cwd: () => string;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

export function defaultServerAddDeps(): ServerAddDeps {
  return {
    resolvePath: () => resolveConfigPath(),
    cwd: () => process.cwd(),
    stdout: (msg) => {
      process.stdout.write(msg);
    },
    stderr: (msg) => {
      process.stderr.write(msg);
    },
  };
}

interface CommonOptions {
  config?: string;
  disabled?: true;
}

export interface AddStdioOptions extends CommonOptions {
  arg?: string[];
  env?: string[];
  cwd?: string;
  timeout?: number;
}

export interface AddHttpOptions extends CommonOptions {
  url: string;
  auth?: 'none' | 'bearer';
  tokenEnv?: string;
  header?: string[];
  timeout?: number;
}

function resolveTargetPath(deps: ServerAddDeps, override: string | undefined): string {
  if (override !== undefined && override.length > 0) {
    return path.resolve(deps.cwd(), override);
  }
  return deps.resolvePath();
}

function parseKeyValuePairs(
  entries: readonly string[],
  flagName: string,
): { ok: true; map: Record<string, string> } | { ok: false; message: string } {
  const map: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      return {
        ok: false,
        message: `Invalid ${flagName} entry: "${entry}". Expected KEY=VALUE.`,
      };
    }
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (key.length === 0) {
      return {
        ok: false,
        message: `Invalid ${flagName} entry: "${entry}". Key must not be empty.`,
      };
    }
    map[key] = value;
  }
  return { ok: true, map };
}

async function loadOrReportMissing(
  target: string,
  deps: ServerAddDeps,
): Promise<ToolboxConfig | null> {
  try {
    return await loadConfig(target);
  } catch (error) {
    if (error instanceof ConfigLoadError) {
      const cause = error.cause as NodeJS.ErrnoException | undefined;
      if (cause?.code === 'ENOENT') {
        deps.stderr(`No Toolbox config found at ${target}. Run \`tlbx init\` first.\n`);
        return null;
      }
      deps.stderr(`${error.message}\n`);
      return null;
    }
    if (error instanceof ConfigValidationError) {
      deps.stderr(`${error.message}\n`);
      return null;
    }
    throw error;
  }
}

function writeAndPrint(
  next: ToolboxConfig,
  name: string,
  target: string,
  deps: ServerAddDeps,
): Promise<void> {
  const entry = next.servers[name];
  deps.stdout(`${JSON.stringify(entry, null, 2)}\n`);
  return saveConfig(next, target);
}

function rejectDuplicate(
  config: ToolboxConfig,
  name: string,
  target: string,
  deps: ServerAddDeps,
): boolean {
  if (Object.prototype.hasOwnProperty.call(config.servers, name)) {
    deps.stderr(`Server "${name}" already exists in ${target}.\n`);
    return true;
  }
  return false;
}

function validateAndSave(
  config: ToolboxConfig,
  name: string,
  entry: StdioServerConfig | HttpServerConfig,
  target: string,
  deps: ServerAddDeps,
): { ok: true; next: ToolboxConfig } | { ok: false } {
  const candidate = {
    ...config,
    servers: { ...config.servers, [name]: entry },
  };
  const result = ToolboxConfigSchema.safeParse(candidate);
  if (!result.success) {
    deps.stderr(`${new ConfigValidationError(result.error, target).message}\n`);
    return { ok: false };
  }
  return { ok: true, next: result.data };
}

export async function runAddStdio(
  name: string,
  commandTokens: readonly string[],
  options: AddStdioOptions,
  deps: ServerAddDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);

  const command = commandTokens[0];
  if (command === undefined || command.length === 0) {
    deps.stderr(
      'Missing command. Pass it after `--`, e.g. `tlbx server add-stdio NAME -- npx ...`.\n',
    );
    return 1;
  }

  const args: string[] = [...commandTokens.slice(1), ...(options.arg ?? [])];

  let env: Record<string, string> | undefined;
  if (options.env !== undefined && options.env.length > 0) {
    const parsed = parseKeyValuePairs(options.env, '--env');
    if (!parsed.ok) {
      deps.stderr(`${parsed.message}\n`);
      return 1;
    }
    env = parsed.map;
  }

  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }
  if (rejectDuplicate(config, name, target, deps)) {
    return 1;
  }

  const entry: StdioServerConfig = {
    type: 'stdio',
    enabled: options.disabled !== true,
    command,
    args,
    ...(env !== undefined ? { env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
  };

  const validated = validateAndSave(config, name, entry, target, deps);
  if (!validated.ok) {
    return 1;
  }
  await writeAndPrint(validated.next, name, target, deps);
  return 0;
}

export async function runAddHttp(
  name: string,
  options: AddHttpOptions,
  deps: ServerAddDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);

  const authType = options.auth ?? 'none';
  if (authType === 'bearer' && (options.tokenEnv === undefined || options.tokenEnv.length === 0)) {
    deps.stderr('--auth bearer requires --token-env <NAME>.\n');
    return 1;
  }
  if (authType === 'none' && options.tokenEnv !== undefined) {
    deps.stderr('--token-env can only be used with --auth bearer.\n');
    return 1;
  }

  let headers: Record<string, string> | undefined;
  if (options.header !== undefined && options.header.length > 0) {
    const parsed = parseKeyValuePairs(options.header, '--header');
    if (!parsed.ok) {
      deps.stderr(`${parsed.message}\n`);
      return 1;
    }
    headers = parsed.map;
  }

  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }
  if (rejectDuplicate(config, name, target, deps)) {
    return 1;
  }

  const entry: HttpServerConfig = {
    type: 'http',
    enabled: options.disabled !== true,
    url: options.url,
    ...(headers !== undefined ? { headers } : {}),
    ...(authType === 'bearer'
      ? { auth: { type: 'bearer', tokenEnv: options.tokenEnv as string } }
      : {}),
    ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
  };

  const validated = validateAndSave(config, name, entry, target, deps);
  if (!validated.ok) {
    return 1;
  }
  await writeAndPrint(validated.next, name, target, deps);
  return 0;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return parsed;
}

function appendOnce(value: string, previous: string[] | undefined): string[] {
  return previous === undefined ? [value] : [...previous, value];
}

export function addStdioCommand(): CommandUnknownOpts {
  return new Command('add-stdio')
    .description('Register a new upstream MCP server that speaks over stdio.')
    .argument('<name>', 'unique server name (alphanumeric, `-`, `_`)')
    .argument('[command...]', 'command and arguments to spawn the server (use `--` to separate)')
    .option('--arg <arg>', 'append an extra argument (repeatable)', appendOnce)
    .option('--env <KEY=VALUE>', 'set an environment variable (repeatable)', appendOnce)
    .option('--cwd <path>', 'working directory for the spawned process')
    .option('--timeout <ms>', 'request timeout in milliseconds', parsePositiveInt)
    .option('--disabled', 'create the server in disabled state')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (name, commandTokens, opts) => {
      const code = await runAddStdio(name, commandTokens, opts, defaultServerAddDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}

export function addHttpCommand(): CommandUnknownOpts {
  return new Command('add-http')
    .description('Register a new upstream MCP server that speaks Streamable HTTP.')
    .argument('<name>', 'unique server name (alphanumeric, `-`, `_`)')
    .requiredOption('--url <url>', 'HTTPS URL of the upstream MCP endpoint')
    .addOption(new Option('--auth <type>', 'authentication scheme').choices(['none', 'bearer']))
    .option('--token-env <NAME>', 'environment variable holding the bearer token')
    .option('--header <KEY=VALUE>', 'set a static request header (repeatable)', appendOnce)
    .option('--timeout <ms>', 'request timeout in milliseconds', parsePositiveInt)
    .option('--disabled', 'create the server in disabled state')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (name, opts) => {
      const code = await runAddHttp(name, opts, defaultServerAddDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
