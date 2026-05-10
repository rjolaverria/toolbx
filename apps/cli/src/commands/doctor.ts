import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  detectCollisions,
  LOOPBACK_HOSTS,
  readToolCache,
  resolveToolCachePath,
  ToolBoxConfigSchema,
  ToolCacheMissingError,
  type CachedTool,
  type ToolBoxConfig,
} from '@toolbox/core';

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

function isFromEnabledServer(issue: ValidationIssue, config: ToolBoxConfig): boolean {
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
      message: `No ToolBox config found at ${target}`,
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
  config: ToolBoxConfig | null,
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
  config: ToolBoxConfig | null,
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
  config: ToolBoxConfig | null,
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

function tryParseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
}

function loadValidatedConfig(parsed: unknown): ToolBoxConfig | null {
  // The downstream checks (server-targets, env-placeholders,
  // namespace-collisions) need a fully-validated config because the schema
  // applies defaults — most importantly `namespacing.separator: '__'`,
  // without which `detectCollisions()` would throw on a hand-edited config
  // that omits the field.
  if (parsed === null) {
    return null;
  }
  const result = ToolBoxConfigSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return result.data;
}

function severitySymbol(severity: CheckSeverity): string {
  return severity;
}

function formatHuman(checks: readonly CheckResult[], options: DoctorOptions): string {
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
  }
  const counts = countSeverities(checks);
  lines.push('');
  lines.push(
    `${checks.length} check(s): ${counts.pass} PASS, ${counts.warn} WARN, ${counts.fail} FAIL`,
  );
  if (options.fix === true) {
    lines.push('--fix: no automatic fixes are available in Phase 1; nothing was changed.');
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
  }>;
  summary: { pass: number; warn: number; fail: number };
  fix: { requested: boolean; applied: readonly string[] };
}

function toJsonReport(
  configPath: string,
  nodeVersion: string,
  checks: readonly CheckResult[],
  options: DoctorOptions,
): JsonReport {
  return {
    configPath,
    node: nodeVersion,
    checks: checks.map((c) => ({
      id: c.id,
      severity: c.severity,
      message: c.message,
      fixHint: c.fixHint ?? null,
      details: c.details ?? [],
    })),
    summary: countSeverities(checks),
    fix: { requested: options.fix === true, applied: [] },
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

  if (options.json === true) {
    deps.stdout(
      `${JSON.stringify(toJsonReport(target, deps.nodeVersion(), checks, options), null, 2)}\n`,
    );
  } else {
    deps.stdout(formatHuman(checks, options));
  }

  return checks.some((c) => c.severity === 'FAIL') ? 1 : 0;
}

export function doctorCommand(): CommandUnknownOpts {
  return new Command('doctor')
    .description('Run a self-check that diagnoses common ToolBox configuration problems.')
    .option('--json', 'emit machine-readable JSON instead of human output')
    .option(
      '--fix',
      'apply safe automatic fixes (Phase 1: reports decisions only, applies nothing)',
    )
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (opts) => {
      const code = await runDoctor(opts, defaultDoctorDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
