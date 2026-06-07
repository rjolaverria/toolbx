import * as path from 'node:path';

import { Command, Option, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { readToolManifest, ToolManifestError } from '@toolbox/custom-tools';
import {
  createNoopLogger,
  createTokenStore,
  probeUpstreamAuth,
  runOAuthLogin,
  saveConfig,
  ServerNameSchema,
  withConfigLock,
  type AuthHint,
  type HttpServerConfig,
  type Logger,
  type RunOAuthLoginInput,
  type RunOAuthLoginResult,
  type StdioServerConfig,
  type StoredOAuthRecord,
  type TokenStorage,
  type TokenStore,
  type ToolBoxConfig,
} from '@toolbox/core';

import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  parsePositiveInt,
  resolveTargetPath,
  validateNextConfig,
  type ServerCommandDeps,
} from './server-shared.js';

export interface ServerAddDeps extends ServerCommandDeps {
  logger: Logger;
  /** Resolves the configured token-store backend. Tests inject an in-memory store. */
  createTokenStore: (storage: TokenStorage) => TokenStore;
  /** Probes an HTTP endpoint to classify its authentication requirement (§4.6.2). */
  probeAuth: (url: URL) => Promise<AuthHint>;
  runOAuthLogin: (input: RunOAuthLoginInput) => Promise<RunOAuthLoginResult>;
  /**
   * Persists the config. Injectable so the OAuth atomicity rollback (a write
   * failure after a successful login) can be exercised in tests; defaults to the
   * real `saveConfig`.
   */
  saveConfig: (config: ToolBoxConfig, target: string) => Promise<void>;
}

export function defaultServerAddDeps(): ServerAddDeps {
  const logger = createNoopLogger();
  return {
    ...defaultServerCommandDeps(),
    logger,
    createTokenStore: (storage) => createTokenStore(storage, { logger }),
    probeAuth: (url) => probeUpstreamAuth(url, { logger }),
    runOAuthLogin,
    saveConfig,
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
  auth?: 'none' | 'bearer' | 'oauth';
  tokenEnv?: string;
  header?: string[];
  timeout?: number;
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

async function saveAndPrint(
  next: ToolBoxConfig,
  name: string,
  target: string,
  deps: ServerCommandDeps,
): Promise<void> {
  await saveConfig(next, target);
  const entry = next.servers[name];
  deps.stdout(`${JSON.stringify(entry, null, 2)}\n`);
}

function rejectDuplicate(
  config: ToolBoxConfig,
  name: string,
  target: string,
  deps: ServerCommandDeps,
): boolean {
  if (Object.prototype.hasOwnProperty.call(config.servers, name)) {
    deps.stderr(`Server "${name}" already exists in ${target}.\n`);
    return true;
  }
  return false;
}

/**
 * Reject a server name that matches an imported custom-tool namespace. The
 * importer already refuses a tool namespace that equals a server name; this is
 * the inverse guard, so the flat exposed-name space cannot collide regardless of
 * which was created first (SPECS design principle 4). Runs before any probe /
 * OAuth side effect. A corrupt tool manifest blocks the add with its own error
 * rather than being silently treated as "no tools".
 */
async function rejectToolNamespaceCollision(
  name: string,
  target: string,
  deps: ServerCommandDeps,
): Promise<boolean> {
  let entries;
  try {
    entries = await readToolManifest(path.dirname(target));
  } catch (error) {
    if (error instanceof ToolManifestError) {
      deps.stderr(`${error.message}\n`);
      return true;
    }
    throw error;
  }
  if (entries.some((entry) => entry.namespace === name)) {
    deps.stderr(
      `Server name "${name}" collides with the namespace of an imported custom tool. ` +
        `Choose a different server name, or remove the custom tool(s) under "${name}" first.\n`,
    );
    return true;
  }
  return false;
}

function buildCandidate(
  config: ToolBoxConfig,
  name: string,
  entry: StdioServerConfig | HttpServerConfig,
): ToolBoxConfig {
  return {
    ...config,
    servers: { ...config.servers, [name]: entry },
  };
}

export async function runAddStdio(
  name: string,
  commandTokens: readonly string[],
  options: AddStdioOptions,
  deps: ServerCommandDeps,
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

  // The duplicate/collision re-check and the write run under the shared
  // config-dir lock so a concurrent `tlbx server`/`tlbx tool` command cannot
  // slip a colliding name in between the check and the write (P3-07).
  return withConfigLock(path.dirname(target), async () => {
    const config = await loadOrReportMissing(target, deps);
    if (config === null) {
      return 1;
    }
    if (rejectDuplicate(config, name, target, deps)) {
      return 1;
    }
    if (await rejectToolNamespaceCollision(name, target, deps)) {
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

    const validated = validateNextConfig(buildCandidate(config, name, entry), target, deps);
    if (!validated.ok) {
      return 1;
    }
    await saveAndPrint(validated.next, name, target, deps);
    return 0;
  });
}

function buildHttpEntry(
  options: AddHttpOptions,
  headers: Record<string, string> | undefined,
  auth: HttpServerConfig['auth'] | undefined,
): HttpServerConfig {
  return {
    type: 'http',
    enabled: options.disabled !== true,
    url: options.url,
    ...(headers !== undefined ? { headers } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
  };
}

/**
 * Build, validate, and persist a static (non-OAuth) HTTP entry, printing the
 * written entry as JSON. Used by the explicit `--auth none | bearer` paths,
 * preserving the pre-OAuth behavior exactly.
 */
async function writeStaticHttpEntry(
  name: string,
  target: string,
  options: AddHttpOptions,
  headers: Record<string, string> | undefined,
  auth: HttpServerConfig['auth'] | undefined,
  deps: ServerCommandDeps,
): Promise<number> {
  // Re-load and re-check under the shared config-dir lock so the duplicate /
  // namespace-collision guards and the write cannot be interleaved by a
  // concurrent `tlbx server`/`tlbx tool` command (P3-07).
  return withConfigLock(path.dirname(target), async () => {
    const config = await loadOrReportMissing(target, deps);
    if (config === null) {
      return 1;
    }
    if (rejectDuplicate(config, name, target, deps)) {
      return 1;
    }
    if (await rejectToolNamespaceCollision(name, target, deps)) {
      return 1;
    }
    const entry = buildHttpEntry(options, headers, auth);
    const validated = validateNextConfig(buildCandidate(config, name, entry), target, deps);
    if (!validated.ok) {
      return 1;
    }
    await saveAndPrint(validated.next, name, target, deps);
    return 0;
  });
}

/** Parse an http(s) URL, reporting a clear error (and returning null) on failure. */
function parseHttpUrl(raw: string, deps: ServerCommandDeps): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    deps.stderr(`Invalid URL "${raw}". Expected an http(s) URL.\n`);
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    deps.stderr(`Invalid URL "${raw}". Expected an http(s) URL.\n`);
    return null;
  }
  return url;
}

/**
 * Restore the token store to its pre-command state after a failed config write,
 * preserving the §4.6.2 atomicity guarantee. A pre-existing record is rewritten;
 * absent one, the freshly-issued token is deleted.
 *
 * Best-effort: the rollback is itself a store write/delete that can fail (e.g.
 * the keychain became unavailable after the initial probe). Returns `false`
 * instead of throwing so the caller can still emit a clean CLI error and tell
 * the user the orphaned token needs manual cleanup, rather than crashing.
 */
async function restorePriorToken(
  tokenStore: TokenStore,
  name: string,
  priorToken: StoredOAuthRecord | null,
): Promise<boolean> {
  try {
    if (priorToken !== null) {
      await tokenStore.write(name, priorToken);
    } else {
      await tokenStore.delete(name);
    }
    return true;
  } catch {
    return false;
  }
}

/** Message shown when a token rollback fails and the credential needs manual cleanup. */
function orphanedTokenHint(name: string): string {
  return `Warning: the OAuth token for ${name} could not be cleaned up. Run \`tlbx auth logout ${name}\`.\n`;
}

/**
 * Run the full browser OAuth flow, then atomically write the `auth: { type:
 * 'oauth' }` config entry. The config is written only after login succeeds, and
 * a config-write failure rolls the token store back to its pre-command state
 * (§4.6.2).
 */
async function runOAuthAndWrite(
  config: ToolBoxConfig,
  name: string,
  target: string,
  options: AddHttpOptions,
  headers: Record<string, string> | undefined,
  serverUrl: URL,
  resourceMetadataUrl: URL | undefined,
  deps: ServerAddDeps,
): Promise<number> {
  const tokenStore = deps.createTokenStore(config.auth.storage);
  const health = await tokenStore.probe();
  if (health.kind === 'unavailable') {
    deps.stderr(`Token storage unavailable: ${health.reason}. Run \`tlbx doctor\` for details.\n`);
    return 3;
  }

  // Snapshot any pre-existing token BEFORE login so a config-write failure can
  // restore the exact prior state. A token here means an orphan from a previous
  // failed attempt — uncommon but real, and §4.6.2 atomicity requires the
  // (config, token) pair to be unchanged on failure. `read` can still throw on a
  // corrupt/incompatible record even after `probe()` reported ready, so surface a
  // readable diagnostic instead of crashing — and do it before opening a browser.
  let priorToken: StoredOAuthRecord | null;
  try {
    priorToken = await tokenStore.read(name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.stderr(
      `Could not read stored credentials for ${name}: ${message}. ` +
        `Run \`tlbx doctor\` or \`tlbx auth logout ${name}\`. ${name} was not registered.\n`,
    );
    return 1;
  }

  deps.stdout(`OAuth required for ${name}. Opening browser to authenticate…\n`);

  const abortController = new AbortController();
  const onSigint = (): void => abortController.abort();
  process.on('SIGINT', onSigint);
  let result: RunOAuthLoginResult;
  try {
    result = await deps.runOAuthLogin({
      serverName: name,
      serverUrl,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      tokenStore,
      logger: deps.logger,
      abortSignal: abortController.signal,
    });
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  if (result.kind === 'cancelled') {
    deps.stderr(`Authentication cancelled. ${name} was not registered.\n`);
    return 2;
  }
  if (result.kind === 'failed') {
    deps.stderr(`Authentication failed: ${result.reason}. ${name} was not registered.\n`);
    return 4;
  }

  // Login succeeded and the token is stored. The duplicate / cross-store
  // collision re-checks and the config write run under the shared config-dir lock
  // so a server or a custom tool registered for this name during the browser flow
  // cannot interleave between the check and the write (P3-07). The config is
  // re-read inside the lock so an unrelated concurrent change is preserved, not
  // clobbered.
  return withConfigLock(path.dirname(target), async () => {
    // Roll back only THIS command's own token. When a prior token existed,
    // restore it. Deleting on the rejectDuplicate path needs care: a concurrent
    // same-name OAuth winner shares this token key, so deleting a freshly-issued
    // token (no prior one) would destroy the winner's credentials — so on that
    // path we leave the store alone when there was no prior token (a benign
    // orphan if the winner is non-OAuth, surfaced by `tlbx doctor`).
    const rollbackThen = async (code: number): Promise<number> => {
      if (!(await restorePriorToken(tokenStore, name, priorToken))) {
        deps.stderr(orphanedTokenHint(name));
      }
      return code;
    };
    const rollbackWithoutDeletingShared = async (code: number): Promise<number> => {
      if (priorToken !== null && !(await restorePriorToken(tokenStore, name, priorToken))) {
        deps.stderr(orphanedTokenHint(name));
      }
      return code;
    };

    const latest = await loadOrReportMissing(target, deps);
    if (latest === null) {
      return rollbackThen(1);
    }
    // A server with this name may have been added during the browser flow.
    if (rejectDuplicate(latest, name, target, deps)) {
      return rollbackWithoutDeletingShared(1);
    }
    if (await rejectToolNamespaceCollision(name, target, deps)) {
      // A colliding custom tool writes no token, so deleting our own is safe.
      return rollbackThen(1);
    }

    const entry = buildHttpEntry(options, headers, { type: 'oauth' });
    const validated = validateNextConfig(buildCandidate(latest, name, entry), target, deps);
    if (!validated.ok) {
      // `validateNextConfig` already reported the validation error to stderr.
      return rollbackThen(1);
    }
    try {
      await deps.saveConfig(validated.next, target);
    } catch (err) {
      const rolledBack = await restorePriorToken(tokenStore, name, priorToken);
      const message = err instanceof Error ? err.message : String(err);
      deps.stderr(`Failed to write config: ${message}. ${name} was not registered.\n`);
      if (!rolledBack) {
        deps.stderr(orphanedTokenHint(name));
      }
      return 1;
    }

    deps.stdout(`✓ ${name} registered (OAuth).\n`);
    return 0;
  });
}

export async function runAddHttp(
  name: string,
  options: AddHttpOptions,
  deps: ServerAddDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);

  if (options.tokenEnv !== undefined && options.auth !== 'bearer') {
    deps.stderr('--token-env can only be used with --auth bearer.\n');
    return 1;
  }
  if (
    options.auth === 'bearer' &&
    (options.tokenEnv === undefined || options.tokenEnv.length === 0)
  ) {
    deps.stderr('--auth bearer requires --token-env <NAME>.\n');
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
  if (await rejectToolNamespaceCollision(name, target, deps)) {
    return 1;
  }

  // Validate the server name before any auth branching. The probe and OAuth
  // paths have side effects (a network request, a browser flow, a token write)
  // that an invalid name should never trigger; failing here keeps invalid CLI
  // input from reaching them.
  const nameResult = ServerNameSchema.safeParse(name);
  if (!nameResult.success) {
    const message = nameResult.error.issues[0]?.message ?? 'invalid server name';
    deps.stderr(`Invalid server name "${name}": ${message}\n`);
    return 1;
  }

  // Explicit `--auth` short-circuits the discovery probe (§4.6.2).
  if (options.auth === 'none') {
    return writeStaticHttpEntry(name, target, options, headers, undefined, deps);
  }
  if (options.auth === 'bearer') {
    return writeStaticHttpEntry(
      name,
      target,
      options,
      headers,
      { type: 'bearer', tokenEnv: options.tokenEnv as string },
      deps,
    );
  }

  // The OAuth and discovery paths both need a parsed URL.
  const serverUrl = parseHttpUrl(options.url, deps);
  if (serverUrl === null) {
    return 1;
  }

  if (options.auth === 'oauth') {
    return runOAuthAndWrite(config, name, target, options, headers, serverUrl, undefined, deps);
  }

  // Discovery mode (no --auth flag): probe the endpoint and branch on the hint.
  const hint = await deps.probeAuth(serverUrl);
  switch (hint.kind) {
    case 'none': {
      // A custom tool with this namespace (or a colliding server) could have
      // been added during the probe; re-read and re-check under the shared lock
      // so the check and the write cannot be interleaved by a concurrent
      // command (P3-07).
      return withConfigLock(path.dirname(target), async () => {
        const latest = await loadOrReportMissing(target, deps);
        if (latest === null) {
          return 1;
        }
        if (rejectDuplicate(latest, name, target, deps)) {
          return 1;
        }
        if (await rejectToolNamespaceCollision(name, target, deps)) {
          return 1;
        }
        const entry = buildHttpEntry(options, headers, { type: 'none' });
        const validated = validateNextConfig(buildCandidate(latest, name, entry), target, deps);
        if (!validated.ok) {
          return 1;
        }
        await deps.saveConfig(validated.next, target);
        deps.stdout(`✓ ${name} registered (no auth required).\n`);
        return 0;
      });
    }
    case 'oauth':
      return runOAuthAndWrite(
        config,
        name,
        target,
        options,
        headers,
        serverUrl,
        hint.resourceMetadataUrl,
        deps,
      );
    case 'bearer':
      deps.stderr(
        `Server "${name}" at ${options.url} requires bearer auth.\n` +
          `Retry with: tlbx server add-http ${name} --url ${options.url} --auth bearer --token-env <YOUR_TOKEN_ENV>\n`,
      );
      return 1;
    case 'unknown':
      deps.stderr(
        `Could not determine the auth scheme for "${name}" at ${options.url} ` +
          `(HTTP ${hint.status}).\n` +
          (hint.body !== undefined ? `Response: ${hint.body}\n` : '') +
          `Re-run with an explicit --auth none | bearer | oauth.\n`,
      );
      return 4;
  }
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
    .requiredOption('--url <url>', 'http(s) URL of the upstream MCP endpoint')
    .addOption(
      new Option('--auth <type>', 'authentication scheme').choices(['none', 'bearer', 'oauth']),
    )
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
