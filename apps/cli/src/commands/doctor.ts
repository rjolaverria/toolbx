import { mkdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  ConfigLockError,
  createNoopLogger,
  createTokenStore,
  DEFAULT_CONFIG,
  detectCollisions,
  LOOPBACK_HOSTS,
  readToolCache,
  resolveCredentialLockRoot,
  resolveToolCachePath,
  saveConfig,
  ToolbxConfigSchema,
  ToolCacheMissingError,
  withCredentialLock,
  type CachedTool,
  type TokenStorage,
  type TokenStore,
  type ToolbxConfig,
} from '@toolbx/core';

import { CREDENTIAL_CONTENTION_LOCK_TIMEOUT_MS, isOAuthServer } from './auth/shared.js';
import {
  collectIssues,
  defaultConfigValidateDeps,
  type ConfigValidateDeps,
  type ValidationIssue,
} from './config-validate.js';
import { resolveTargetPath } from './server-shared.js';

export type CheckSeverity = 'PASS' | 'WARN' | 'FAIL';

export interface CheckResult {
  id: string;
  severity: CheckSeverity;
  message: string;
  /** One-line "how to fix" hint. Required for FAIL. */
  fixHint?: string;
  /** Multi-line details rendered indented in human output. */
  details?: readonly string[];
}

export interface DoctorOptions {
  config?: string;
  json?: true;
  fix?: boolean;
  yes?: true;
}

export interface DoctorDeps extends ConfigValidateDeps {
  /** Returns the engines.node range from the CLI's own package.json. */
  readEnginesNode: () => Promise<string | undefined>;
  /** Returns the cached upstream tool list, or 'missing' when no cache exists. */
  readToolCacheAt: (configPath: string) => Promise<readonly CachedTool[] | 'missing'>;
  /** Process Node.js version (defaults to `process.version`). */
  nodeVersion: () => string;
  /** Reads the resolved config source; returns null on ENOENT. */
  readConfigSource: (target: string) => Promise<string | null>;
  /** Prompts the user to confirm a mutating fix. Resolves true to proceed. */
  confirmFix: (prompt: string) => Promise<boolean>;
  /** Resolves the configured token-store backend. Tests inject an in-memory store. */
  createTokenStore: (storage: TokenStorage) => TokenStore;
  /** Host platform, used to tailor token-store remediation hints. */
  platform: () => NodeJS.Platform;
}

const PACKAGE_JSON_PATH = (() => {
  // dist/commands/doctor.js → ../../package.json
  // src/commands/doctor.ts  → ../../package.json
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'package.json');
})();

export function defaultDoctorDeps(): DoctorDeps {
  return {
    ...defaultConfigValidateDeps(),
    nodeVersion: () => process.version,
    readEnginesNode: async () => {
      try {
        const raw = await readFile(PACKAGE_JSON_PATH, 'utf8');
        const parsed = JSON.parse(raw) as { engines?: { node?: string } };
        return parsed.engines?.node;
      } catch {
        return undefined;
      }
    },
    readToolCacheAt: async (configPath) => {
      const cachePath = path.join(path.dirname(configPath), path.basename(resolveToolCachePath()));
      try {
        const cache = await readToolCache(cachePath);
        return cache.tools;
      } catch (error) {
        if (error instanceof ToolCacheMissingError) {
          return 'missing';
        }
        throw error;
      }
    },
    readConfigSource: async (target) => {
      try {
        return await readFile(target, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    confirmFix: async (prompt) => {
      if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
        return false;
      }
      // Prompt on stderr (like `tlbx server remove`) so it never corrupts
      // stdout — important when stdout is redirected or carries `--json`.
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(`${prompt} [y/N] `);
        return /^y(?:es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
    createTokenStore: (storage) => createTokenStore(storage, { logger: createNoopLogger() }),
    platform: () => process.platform,
  };
}

/**
 * Returns true when `version` satisfies a `>=major[.minor[.patch]]` range,
 * false when it does not, and `'unknown'` when the range cannot be parsed.
 * Doctor is tolerant of unknown ranges — it warns instead of failing.
 */
export function nodeSatisfies(version: string, range: string): boolean | 'unknown' {
  const trimmed = range.trim();
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
  if (!m) {
    return 'unknown';
  }
  const minMajor = Number(m[1]);
  const minMinor = m[2] !== undefined ? Number(m[2]) : 0;
  const minPatch = m[3] !== undefined ? Number(m[3]) : 0;
  const v = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!v) {
    return 'unknown';
  }
  const major = Number(v[1]);
  const minor = Number(v[2]);
  const patch = Number(v[3]);
  if (major !== minMajor) {
    return major > minMajor;
  }
  if (minor !== minMinor) {
    return minor > minMinor;
  }
  return patch >= minPatch;
}

export function checkNodeVersion(actual: string, range: string | undefined): CheckResult {
  if (range === undefined) {
    return {
      id: 'node-version',
      severity: 'WARN',
      message: `Node.js ${actual} (no engines.node declared in apps/cli/package.json)`,
    };
  }
  const ok = nodeSatisfies(actual, range);
  if (ok === 'unknown') {
    return {
      id: 'node-version',
      severity: 'WARN',
      message: `Node.js ${actual}: cannot interpret engines range "${range}"`,
    };
  }
  if (ok) {
    return {
      id: 'node-version',
      severity: 'PASS',
      message: `Node.js ${actual} satisfies "${range}"`,
    };
  }
  return {
    id: 'node-version',
    severity: 'FAIL',
    message: `Node.js ${actual} does not satisfy "${range}"`,
    fixHint: `Install Node.js ${range} (e.g. with nvm, fnm, or volta)`,
  };
}

function formatIssue(issue: ValidationIssue): string {
  const ptr = issue.pointer.length === 0 ? '<root>' : issue.pointer;
  return `[${issue.category}] ${ptr}: ${issue.message}`;
}

function decodePointerSegment(segment: string): string {
  // RFC 6901: `~1` decodes to `/`, then `~0` decodes to `~`.
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function pointerServerName(pointer: string): string | null {
  const segments = pointer.split('/').filter((s) => s.length > 0);
  if (segments.length < 2 || segments[0] !== 'servers') {
    return null;
  }
  const raw = segments[1];
  return raw === undefined ? null : decodePointerSegment(raw);
}

function isFromEnabledServer(issue: ValidationIssue, config: ToolbxConfig): boolean {
  const name = pointerServerName(issue.pointer);
  if (name === null) {
    return false;
  }
  return config.servers[name]?.enabled === true;
}

export function checkConfigValidate(
  target: string,
  source: string | null,
  issues: readonly ValidationIssue[],
): CheckResult {
  if (source === null) {
    return {
      id: 'config',
      severity: 'FAIL',
      message: `No Toolbx config found at ${target}`,
      fixHint: 'Run `tlbx init` to create a default config',
    };
  }
  const blocking = issues.filter(
    (i) => i.category === 'json' || i.category === 'schema' || i.category === 'duplicate-name',
  );
  if (blocking.length === 0) {
    return {
      id: 'config',
      severity: 'PASS',
      message: `Config at ${target} parses and validates`,
    };
  }
  return {
    id: 'config',
    severity: 'FAIL',
    message: `Config at ${target} has ${blocking.length} structural issue(s)`,
    fixHint: 'Run `tlbx config validate` for the full list',
    details: blocking.map(formatIssue),
  };
}

export function checkServerTargets(
  config: ToolbxConfig | null,
  issues: readonly ValidationIssue[],
): CheckResult {
  if (config === null) {
    return {
      id: 'server-targets',
      severity: 'WARN',
      message: 'Skipped (config not loaded)',
    };
  }
  const enabled = Object.entries(config.servers).filter(([, e]) => e.enabled);
  if (enabled.length === 0) {
    return {
      id: 'server-targets',
      severity: 'PASS',
      message: 'No enabled servers; nothing to check',
    };
  }
  const broken = issues.filter(
    (i) =>
      (i.category === 'broken-command' || i.category === 'invalid-url') &&
      isFromEnabledServer(i, config),
  );
  if (broken.length === 0) {
    return {
      id: 'server-targets',
      severity: 'PASS',
      message: `All ${enabled.length} enabled server target(s) resolved`,
    };
  }
  return {
    id: 'server-targets',
    severity: 'FAIL',
    message: `${broken.length} enabled server target(s) cannot be resolved`,
    fixHint: 'Inspect with `tlbx server inspect <name>` and fix with `tlbx server edit <name>`',
    details: broken.map(formatIssue),
  };
}

export function checkEnvPlaceholders(
  config: ToolbxConfig | null,
  issues: readonly ValidationIssue[],
): CheckResult {
  if (config === null) {
    return {
      id: 'env-placeholders',
      severity: 'WARN',
      message: 'Skipped (config not loaded)',
    };
  }
  const missing = issues.filter(
    (i) => i.category === 'missing-env' && isFromEnabledServer(i, config),
  );
  if (missing.length === 0) {
    return {
      id: 'env-placeholders',
      severity: 'PASS',
      message: 'All ${env:NAME} placeholders for enabled servers are set',
    };
  }
  return {
    id: 'env-placeholders',
    severity: 'FAIL',
    message: `${missing.length} unresolved environment variable(s)`,
    fixHint: 'Export the missing variables in your shell or update the config',
    details: missing.map(formatIssue),
  };
}

export function checkNamespaceCollisions(
  config: ToolbxConfig | null,
  issues: readonly ValidationIssue[],
  cache: readonly CachedTool[] | 'missing',
): CheckResult {
  if (config === null) {
    return {
      id: 'namespace-collisions',
      severity: 'WARN',
      message: 'Skipped (config not loaded)',
    };
  }
  const configLevel = issues.filter((i) => i.category === 'namespace-collision');
  if (configLevel.length > 0) {
    return {
      id: 'namespace-collisions',
      severity: 'FAIL',
      message: `${configLevel.length} namespace collision(s) in config`,
      fixHint: 'Rename the affected servers or tool overrides in the config',
      details: configLevel.map(formatIssue),
    };
  }
  if (cache === 'missing') {
    return {
      id: 'namespace-collisions',
      severity: 'WARN',
      message: 'No tool registry snapshot yet; run `tlbx serve` once to populate it',
    };
  }
  const toolsByServer: Record<string, string[]> = {};
  for (const tool of cache) {
    if (config.servers[tool.serverName]?.enabled !== true) {
      continue;
    }
    const list = toolsByServer[tool.serverName] ?? [];
    list.push(tool.upstreamName);
    toolsByServer[tool.serverName] = list;
  }
  const collisions = detectCollisions(toolsByServer, config.namespacing);
  if (collisions.length === 0) {
    return {
      id: 'namespace-collisions',
      severity: 'PASS',
      message: 'No namespace collisions in cached tool registry',
    };
  }
  return {
    id: 'namespace-collisions',
    severity: 'FAIL',
    message: `${collisions.length} namespace collision(s) across enabled servers`,
    fixHint:
      'Disable a colliding tool with `tlbx tools disable <name>` or change `namespacing.collisionStrategy`',
    details: collisions.map(
      (c) =>
        `${c.exposedName}: ${c.sources.map((s) => `${s.serverName}/${s.upstreamName}`).join(', ')}`,
    ),
  };
}

export function checkBindAddress(host: string | null): CheckResult {
  if (host === null) {
    // Either the config was unreadable or `server.http.host` is missing/wrong
    // type. Either way, the dedicated bind-address check has nothing to act
    // on; the structural problem is surfaced by `config` instead.
    return {
      id: 'bind-address',
      severity: 'WARN',
      message: 'Skipped (no server.http.host available)',
    };
  }
  const isLoopback = (LOOPBACK_HOSTS as readonly string[]).includes(host);
  if (isLoopback) {
    return {
      id: 'bind-address',
      severity: 'PASS',
      message: `server.http.host "${host}" is loopback`,
    };
  }
  return {
    id: 'bind-address',
    severity: 'FAIL',
    message: `server.http.host "${host}" is not loopback (Phase 1 only allows ${LOOPBACK_HOSTS.join(', ')})`,
    fixHint: 'Run `tlbx config set server.http.host 127.0.0.1`',
  };
}

/**
 * Best-effort extraction of `server.http.host`. The bind-address check runs
 * even when full schema validation fails so that a non-loopback host (which
 * the schema rejects) still produces the targeted FAIL with a fix hint
 * instead of a generic "skipped" warning.
 */
export function extractBindHost(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const server = (parsed as Record<string, unknown>)['server'];
  if (server === null || typeof server !== 'object') {
    return null;
  }
  const http = (server as Record<string, unknown>)['http'];
  if (http === null || typeof http !== 'object') {
    return null;
  }
  const host = (http as Record<string, unknown>)['host'];
  return typeof host === 'string' ? host : null;
}

/** Sorted names of HTTP servers configured with `auth.type === 'oauth'`. */
function oauthServerNames(config: ToolbxConfig): string[] {
  return Object.entries(config.servers)
    .filter(([, entry]) => isOAuthServer(entry))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Platform-tailored remediation for an unavailable token store. Best-effort:
 * the underlying `probe()` reason already carries the precise error, so this
 * only points the user at the most likely cause for their OS.
 */
export function tokenStoreUnavailableHint(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'macOS Keychain access denied — run `tlbx auth login <server>` and approve the prompt';
  }
  if (platform === 'linux') {
    return 'Linux: install gnome-keyring or kwallet and start the secret service, then retry';
  }
  return 'Ensure your OS credential store is reachable, then run `tlbx auth login <server>`';
}

export interface AuthCheckResult {
  /** Rows to splice into the doctor report (empty when the section is omitted). */
  rows: readonly CheckResult[];
  /** Server names with a stored token but no matching OAuth config entry. */
  orphans: readonly string[];
  /** OAuth-configured server names with no stored token. */
  missing: readonly string[];
}

const NO_AUTH_SECTION: AuthCheckResult = { rows: [], orphans: [], missing: [] };

interface AuthRowsInput {
  orphans?: readonly string[];
  missing?: readonly string[];
  /** Servers whose stored credential exists but could not be read (e.g. corrupt). */
  unreadable?: readonly { name: string; reason: string }[];
  /** Set when `list()` failed, so orphan detection could not run. */
  enumerationError?: string | null;
}

/** Assemble the Auth section: a store-health PASS row plus drift/health rows. */
function authRows(storageType: string, input: AuthRowsInput): CheckResult[] {
  const rows: CheckResult[] = [
    { id: 'auth-store', severity: 'PASS', message: `Token store (${storageType}) is available` },
  ];
  if (input.enumerationError != null) {
    rows.push({
      id: 'auth-orphans-unavailable',
      severity: 'WARN',
      message: `Orphan-token detection skipped: could not enumerate the token store (${input.enumerationError})`,
    });
  }
  for (const name of input.orphans ?? []) {
    rows.push({
      id: `auth-orphan:${name}`,
      severity: 'WARN',
      message: `Orphan token for "${name}" — server entry not in config`,
    });
  }
  for (const name of input.missing ?? []) {
    rows.push({
      id: `auth-missing:${name}`,
      severity: 'WARN',
      message: `Missing token for "${name}" — run \`tlbx auth login ${name}\``,
    });
  }
  for (const { name, reason } of input.unreadable ?? []) {
    rows.push({
      id: `auth-unreadable:${name}`,
      severity: 'FAIL',
      message: `Stored credentials for "${name}" are unreadable: ${reason}`,
      fixHint: `Run \`tlbx auth login ${name}\` to re-authenticate and overwrite the entry`,
    });
  }
  return rows;
}

/**
 * Token-store health and config/token drift. The section is gated on "OAuth in
 * config OR tokens in store" so it stays silent for users who do not use OAuth.
 *
 * When no OAuth server is configured we deliberately avoid `probe()`: on the
 * keychain backend it writes and deletes a sentinel credential, which would
 * touch (or prompt for) the OS credential store on every `tlbx doctor` run even
 * for users with no tokens. The read-only `list()` is enough to decide whether
 * there is anything (orphan tokens) worth reporting.
 */
export async function checkAuth(
  config: ToolbxConfig,
  tokenStore: TokenStore,
  storageType: string,
  platform: NodeJS.Platform,
): Promise<AuthCheckResult> {
  const oauthNames = oauthServerNames(config);

  if (oauthNames.length === 0) {
    // The only thing worth reporting without OAuth config is orphan tokens, and
    // those only surface through `list()`. Use it (read-only) instead of
    // `probe()`, and stay silent when it is empty, unsupported, or throws.
    let stored: readonly string[];
    try {
      stored = await tokenStore.list();
    } catch {
      return NO_AUTH_SECTION;
    }
    if (stored.length === 0) {
      return NO_AUTH_SECTION;
    }
    const orphans = [...stored].sort((a, b) => a.localeCompare(b));
    return { rows: authRows(storageType, { orphans }), orphans, missing: [] };
  }

  // OAuth is configured, so store health genuinely matters — probe it. A
  // keychain prompt here is expected: the user explicitly relies on OAuth.
  const health = await tokenStore.probe();
  if (health.kind === 'unavailable') {
    return {
      rows: [
        {
          id: 'auth-store',
          severity: 'FAIL',
          message: `Token store (${storageType}) is unavailable: ${health.reason}`,
          fixHint: tokenStoreUnavailableHint(platform),
        },
      ],
      orphans: [],
      missing: [],
    };
  }

  // Orphan detection needs enumeration. `list()`'s contract allows a successful
  // `[]` to mean either "no records" or "enumeration unsupported", and the call
  // may also throw. A successful empty result is treated as "no orphans"; a
  // failure is surfaced as a WARN (`enumerationError`) so the user knows orphan
  // detection was skipped rather than silently assuming there are none.
  let stored: readonly string[] = [];
  let enumerationError: string | null = null;
  try {
    stored = await tokenStore.list();
  } catch (error) {
    enumerationError = error instanceof Error ? error.message : String(error);
  }

  // Missing-token detection reads each configured server directly rather than
  // trusting `list()`: an empty/unsupported enumeration would otherwise report
  // servers with valid stored credentials as missing. A `read()` that throws
  // means an entry exists but is unreadable (e.g. corrupt); that is a real,
  // separate problem (`auth status`, refresh, and gateway use will fail on it),
  // so it is surfaced as a FAIL row rather than silently treated as present.
  const missing: string[] = [];
  const unreadable: { name: string; reason: string }[] = [];
  for (const name of oauthNames) {
    try {
      if ((await tokenStore.read(name)) === null) {
        missing.push(name);
      }
    } catch (error) {
      unreadable.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const configured = new Set(oauthNames);
  const orphans = [...stored]
    .filter((name) => !configured.has(name))
    .sort((a, b) => a.localeCompare(b));

  return {
    rows: authRows(storageType, { orphans, missing, unreadable, enumerationError }),
    orphans,
    missing,
  };
}

function tryParseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
}

function loadValidatedConfig(parsed: unknown): ToolbxConfig | null {
  // The downstream checks (server-targets, env-placeholders,
  // namespace-collisions) need a fully-validated config because the schema
  // applies defaults — most importantly `namespacing.separator: '__'`,
  // without which `detectCollisions()` would throw on a hand-edited config
  // that omits the field.
  if (parsed === null) {
    return null;
  }
  const result = ToolbxConfigSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return result.data;
}

export type FixStatus = 'APPLIED' | 'SKIPPED_DECLINED' | 'SKIPPED_NO_FIX';

export interface FixOutcome {
  status: FixStatus;
  /** Short description of the action taken (only meaningful when APPLIED). */
  summary: string;
  /** Extra lines (e.g. a shell snippet) printed indented under the summary. */
  lines?: readonly string[];
}

interface FixContext {
  target: string;
  source: string | null;
  config: ToolbxConfig | null;
  issues: readonly ValidationIssue[];
  options: DoctorOptions;
  deps: DoctorDeps;
}

const NO_FIX: FixOutcome = { status: 'SKIPPED_NO_FIX', summary: 'no automatic fix available' };
const DECLINED: FixOutcome = { status: 'SKIPPED_DECLINED', summary: 'declined' };

const ENV_VAR_FROM_ISSUE_RE = /^environment variable "([A-Za-z_][A-Za-z0-9_]*)"/;

function missingEnvVarNames(
  config: ToolbxConfig,
  issues: readonly ValidationIssue[],
): readonly string[] {
  const names = new Set<string>();
  for (const issue of issues) {
    if (issue.category !== 'missing-env' || !isFromEnabledServer(issue, config)) {
      continue;
    }
    const name = ENV_VAR_FROM_ISSUE_RE.exec(issue.message)?.[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names].sort();
}

type DirState = 'directory' | 'missing' | 'not-a-directory';

async function inspectDir(dir: string): Promise<DirState> {
  try {
    const stats = await stat(dir);
    return stats.isDirectory() ? 'directory' : 'not-a-directory';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

function confirmAction(ctx: FixContext, action: string): Promise<boolean> {
  if (ctx.options.yes === true) {
    return Promise.resolve(true);
  }
  if (ctx.options.json === true) {
    // An interactive prompt would corrupt the JSON document on stdout — in
    // `--json` mode a fix only runs when `--yes` was passed.
    return Promise.resolve(false);
  }
  return ctx.deps.confirmFix(`${action}?`);
}

async function fixMissingConfig(ctx: FixContext): Promise<FixOutcome> {
  const dir = path.dirname(ctx.target);
  const dirState = await inspectDir(dir);
  if (dirState === 'not-a-directory') {
    return {
      status: 'SKIPPED_NO_FIX',
      summary: `${dir} exists but is not a directory — resolve it manually or point TOOLBX_CONFIG elsewhere`,
    };
  }
  const dirExisted = dirState === 'directory';
  const action = dirExisted
    ? `Write a default Toolbx config to ${ctx.target}`
    : `Create ${dir} and write a default Toolbx config to ${ctx.target}`;
  if (!(await confirmAction(ctx, action))) {
    return DECLINED;
  }
  if (!dirExisted) {
    // Fail loud if the parent directory cannot be created (e.g. it lives on a
    // read-only volume) — never silently fall back to the default location.
    await mkdir(dir, { recursive: true });
  }
  await saveConfig(DEFAULT_CONFIG, ctx.target);
  return {
    status: 'APPLIED',
    summary: dirExisted
      ? `wrote a default config to ${ctx.target}`
      : `created config directory ${dir} and wrote a default config to ${ctx.target}`,
  };
}

async function fixMissingEnvVars(ctx: FixContext): Promise<FixOutcome> {
  if (ctx.config === null) {
    return NO_FIX;
  }
  const names = missingEnvVarNames(ctx.config, ctx.issues);
  if (names.length === 0) {
    return NO_FIX;
  }
  const action = `Print a copy-pasteable export snippet for ${names.length} environment variable(s)`;
  if (!(await confirmAction(ctx, action))) {
    return DECLINED;
  }
  return {
    status: 'APPLIED',
    summary: 'printed an export snippet for the missing environment variable(s)',
    lines: names.map((name) => `export ${name}=...`),
  };
}

async function fixOrphanToken(
  name: string,
  tokenStore: TokenStore,
  credentialLockRoot: string,
  ctx: FixContext,
): Promise<FixOutcome> {
  const action = `Delete the orphan OAuth token for "${name}" (no matching server in config)`;
  if (!(await confirmAction(ctx, action))) {
    return DECLINED;
  }
  // Safe to prune: the user can always re-run `tlbx auth login <name>`. Deletion
  // can still fail (permission denied, store became unavailable) — report that
  // as a skipped fix rather than letting it abort the whole doctor run.
  try {
    await withCredentialLock(credentialLockRoot, name, () => tokenStore.delete(name), {
      timeoutMs: CREDENTIAL_CONTENTION_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof ConfigLockError) {
      // A same-name credential command (e.g. an in-progress login) holds the
      // lock. Skip cleanly and tell the user to retry — never surface the raw
      // lock-file removal advice as if doctor's own state were corrupt.
      return {
        status: 'SKIPPED_NO_FIX',
        summary: `another credential operation for "${name}" is in progress; skipped (re-run \`tlbx doctor --fix\` once it finishes)`,
      };
    }
    return {
      status: 'SKIPPED_NO_FIX',
      summary: `could not delete orphan token for "${name}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { status: 'APPLIED', summary: `deleted orphan token for "${name}"` };
}

/**
 * Missing tokens are never auto-fixed: silently opening a browser from
 * `doctor --fix` would violate the "browser only opens from explicit user
 * action" principle. We report the manual remediation instead.
 */
function missingTokenFixNotice(name: string): FixOutcome {
  return {
    status: 'SKIPPED_NO_FIX',
    summary: `run \`tlbx auth login ${name}\` to obtain the missing token`,
  };
}

function runFixerForCheck(check: CheckResult, ctx: FixContext): Promise<FixOutcome> {
  if (check.id === 'config' && ctx.source === null) {
    return fixMissingConfig(ctx);
  }
  if (check.id === 'env-placeholders') {
    return fixMissingEnvVars(ctx);
  }
  return Promise.resolve(NO_FIX);
}

async function applyFixes(
  checks: readonly CheckResult[],
  ctx: FixContext,
): Promise<Map<string, FixOutcome>> {
  const outcomes = new Map<string, FixOutcome>();
  for (const check of checks) {
    if (check.severity !== 'FAIL') {
      continue;
    }
    outcomes.set(check.id, await runFixerForCheck(check, ctx));
  }
  return outcomes;
}

function fixStatusLabel(status: FixStatus): string {
  if (status === 'APPLIED') {
    return 'APPLIED';
  }
  if (status === 'SKIPPED_DECLINED') {
    return 'SKIPPED (declined)';
  }
  return 'SKIPPED (no fix available)';
}

function formatFixLine(outcome: FixOutcome): string {
  const label = fixStatusLabel(outcome.status);
  if (outcome.status === 'APPLIED') {
    return `--fix: ${outcome.summary} [APPLIED]`;
  }
  if (outcome.status === 'SKIPPED_NO_FIX' && outcome.summary !== NO_FIX.summary) {
    return `--fix: ${label}: ${outcome.summary}`;
  }
  return `--fix: ${label}`;
}

function fixSummaryFooter(outcomes: ReadonlyMap<string, FixOutcome>): string {
  if (outcomes.size === 0) {
    return '--fix: no failing checks to fix.';
  }
  let applied = 0;
  let declined = 0;
  let noFix = 0;
  for (const outcome of outcomes.values()) {
    if (outcome.status === 'APPLIED') {
      applied += 1;
    } else if (outcome.status === 'SKIPPED_DECLINED') {
      declined += 1;
    } else {
      noFix += 1;
    }
  }
  return `--fix: ${applied} applied, ${declined} declined, ${noFix} with no available fix.`;
}

function severitySymbol(severity: CheckSeverity): string {
  return severity;
}

function formatHuman(
  checks: readonly CheckResult[],
  options: DoctorOptions,
  fixOutcomes: ReadonlyMap<string, FixOutcome>,
): string {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`[${severitySymbol(check.severity)}] ${check.id}: ${check.message}`);
    if (check.details !== undefined) {
      for (const detail of check.details) {
        lines.push(`        ${detail}`);
      }
    }
    if (check.severity === 'FAIL' && check.fixHint !== undefined) {
      lines.push(`        fix: ${check.fixHint}`);
    }
    const outcome = fixOutcomes.get(check.id);
    if (outcome !== undefined) {
      lines.push(`        ${formatFixLine(outcome)}`);
      if (outcome.lines !== undefined) {
        for (const line of outcome.lines) {
          lines.push(`            ${line}`);
        }
      }
    }
  }
  const counts = countSeverities(checks);
  lines.push('');
  lines.push(
    `${checks.length} check(s): ${counts.pass} PASS, ${counts.warn} WARN, ${counts.fail} FAIL`,
  );
  if (options.fix === true) {
    lines.push(fixSummaryFooter(fixOutcomes));
  }
  return `${lines.join('\n')}\n`;
}

function countSeverities(checks: readonly CheckResult[]): {
  pass: number;
  warn: number;
  fail: number;
} {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const c of checks) {
    if (c.severity === 'PASS') {
      pass += 1;
    } else if (c.severity === 'WARN') {
      warn += 1;
    } else {
      fail += 1;
    }
  }
  return { pass, warn, fail };
}

interface JsonReport {
  configPath: string;
  node: string;
  checks: ReadonlyArray<{
    id: string;
    severity: CheckSeverity;
    message: string;
    fixHint: string | null;
    details: readonly string[];
    fix: { status: FixStatus; summary: string; lines: readonly string[] } | null;
  }>;
  summary: { pass: number; warn: number; fail: number };
  fix: { requested: boolean; applied: readonly string[] };
}

function toJsonReport(
  configPath: string,
  nodeVersion: string,
  checks: readonly CheckResult[],
  options: DoctorOptions,
  fixOutcomes: ReadonlyMap<string, FixOutcome>,
): JsonReport {
  const applied: string[] = [];
  for (const [id, outcome] of fixOutcomes) {
    if (outcome.status === 'APPLIED') {
      applied.push(id);
    }
  }
  return {
    configPath,
    node: nodeVersion,
    checks: checks.map((c) => {
      const outcome = fixOutcomes.get(c.id);
      return {
        id: c.id,
        severity: c.severity,
        message: c.message,
        fixHint: c.fixHint ?? null,
        details: c.details ?? [],
        fix:
          outcome === undefined
            ? null
            : { status: outcome.status, summary: outcome.summary, lines: outcome.lines ?? [] },
      };
    }),
    summary: countSeverities(checks),
    fix: { requested: options.fix === true, applied },
  };
}

export async function runDoctor(options: DoctorOptions, deps: DoctorDeps): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const checks: CheckResult[] = [];

  const enginesNode = await deps.readEnginesNode();
  checks.push(checkNodeVersion(deps.nodeVersion(), enginesNode));

  const source = await deps.readConfigSource(target);
  let issues: readonly ValidationIssue[] = [];
  if (source !== null) {
    issues = await collectIssues(source, deps);
  }
  checks.push(checkConfigValidate(target, source, issues));

  const parsed = source === null ? null : tryParseJson(source);
  const config = loadValidatedConfig(parsed);
  checks.push(checkServerTargets(config, issues));
  checks.push(checkEnvPlaceholders(config, issues));

  let cache: readonly CachedTool[] | 'missing' = 'missing';
  if (config !== null) {
    cache = await deps.readToolCacheAt(target);
  }
  checks.push(checkNamespaceCollisions(config, issues, cache));
  // Bind-address runs from the raw parse so a non-loopback host (which the
  // schema rejects) still produces the targeted FAIL with a fix hint instead
  // of being swallowed by the generic config-validation failure path.
  checks.push(checkBindAddress(extractBindHost(parsed)));

  // Auth section runs last, only when the config loaded — it needs the resolved
  // `auth.storage` backend and the validated server list.
  let tokenStore: TokenStore | null = null;
  let auth: AuthCheckResult = NO_AUTH_SECTION;
  if (config !== null) {
    tokenStore = deps.createTokenStore(config.auth.storage);
    auth = await checkAuth(config, tokenStore, config.auth.storage.type, deps.platform());
    checks.push(...auth.rows);
  }

  const fixCtx: FixContext = { target, source, config, issues, options, deps };
  const fixOutcomes = new Map<string, FixOutcome>(
    options.fix === true ? await applyFixes(checks, fixCtx) : [],
  );
  if (options.fix === true && tokenStore !== null && config !== null) {
    // Orphan and missing tokens are WARN rows, so the FAIL-only generic fixer
    // above skips them: `--fix` prunes orphan tokens and only reports the manual
    // remediation for missing ones. The credential lock is rooted at the backend
    // domain (machine-global for the keychain), matching the CLI credential
    // commands and the gateway so a concurrent same-name op serializes.
    const credentialLockRoot = resolveCredentialLockRoot(config.auth.storage);
    for (const name of auth.orphans) {
      fixOutcomes.set(
        `auth-orphan:${name}`,
        await fixOrphanToken(name, tokenStore, credentialLockRoot, fixCtx),
      );
    }
    for (const name of auth.missing) {
      fixOutcomes.set(`auth-missing:${name}`, missingTokenFixNotice(name));
    }
  }

  if (options.json === true) {
    deps.stdout(
      `${JSON.stringify(toJsonReport(target, deps.nodeVersion(), checks, options, fixOutcomes), null, 2)}\n`,
    );
  } else {
    deps.stdout(formatHuman(checks, options, fixOutcomes));
  }

  // The exit code reflects the checks as observed before any fix ran — a fix
  // that mutates the system (writing a default config) only takes effect on
  // the next `tlbx doctor` invocation, and a guided fix (the env snippet)
  // leaves the underlying check FAIL until the user runs the snippet.
  return checks.some((c) => c.severity === 'FAIL') ? 1 : 0;
}

export function doctorCommand(): CommandUnknownOpts {
  return new Command('doctor')
    .description('Run a self-check that diagnoses common Toolbx configuration problems.')
    .option('--json', 'emit machine-readable JSON instead of human output')
    .option('--fix', 'apply safe automatic fixes (prompts for confirmation unless --yes is given)')
    .option('-y, --yes', 'apply fixes without prompting (only meaningful with --fix)')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (opts) => {
      const code = await runDoctor(opts, defaultDoctorDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
