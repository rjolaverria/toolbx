import * as path from 'node:path';

import { InvalidArgumentError } from '@commander-js/extra-typings';
import {
  ConfigLoadError,
  ConfigValidationError,
  loadConfig,
  resolveConfigPath,
  ToolBoxConfigSchema,
  type ServerConfig,
  type ToolBoxConfig,
} from '@rjolaverria/toolbox-core';

export interface ServerCommandDeps {
  resolvePath: () => string;
  cwd: () => string;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

export function defaultServerCommandDeps(): ServerCommandDeps {
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

export function resolveTargetPath(deps: ServerCommandDeps, override: string | undefined): string {
  if (override !== undefined && override.length > 0) {
    return path.resolve(deps.cwd(), override);
  }
  return deps.resolvePath();
}

export async function loadOrReportMissing(
  target: string,
  deps: ServerCommandDeps,
): Promise<ToolBoxConfig | null> {
  try {
    return await loadConfig(target);
  } catch (error) {
    if (error instanceof ConfigLoadError) {
      const cause = error.cause as NodeJS.ErrnoException | undefined;
      if (cause?.code === 'ENOENT') {
        deps.stderr(`No ToolBox config found at ${target}. Run \`tlbx init\` first.\n`);
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

export function requireExistingServer(
  config: ToolBoxConfig,
  name: string,
  target: string,
  deps: ServerCommandDeps,
): ServerConfig | null {
  const entry = config.servers[name];
  if (entry === undefined) {
    deps.stderr(`Unknown server "${name}" in ${target}.\n`);
    return null;
  }
  return entry;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function parsePositiveInt(value: string): number {
  const trimmed = value.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return parsed;
}

export function validateNextConfig(
  candidate: unknown,
  target: string,
  deps: ServerCommandDeps,
): { ok: true; next: ToolBoxConfig } | { ok: false } {
  const result = ToolBoxConfigSchema.safeParse(candidate);
  if (!result.success) {
    deps.stderr(`${new ConfigValidationError(result.error, target).message}\n`);
    return { ok: false };
  }
  return { ok: true, next: result.data };
}
