import * as path from 'node:path';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  ConfigLoadError,
  ConfigValidationError,
  DuplicateKeyError,
  loadConfig,
  saveConfig,
  ToolBoxConfigSchema,
  withConfigLock,
} from '@rjolaverria/toolbox-core';

import {
  defaultServerCommandDeps,
  resolveTargetPath,
  type ServerCommandDeps,
} from './server-shared.js';

export interface ConfigSetOptions {
  config?: string;
}

export type ConfigSetDeps = ServerCommandDeps;

export function defaultConfigSetDeps(): ConfigSetDeps {
  return defaultServerCommandDeps();
}

export class InvalidConfigPathError extends Error {
  override readonly name = 'InvalidConfigPathError';
  constructor(message: string) {
    super(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Segment names that would mutate `Object.prototype` via plain-property
// assignment. Rejecting them up front lets `setAtPath` use a normal index
// write without becoming a prototype-pollution vector.
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function parseDottedPath(input: string): string[] {
  if (input.length === 0) {
    throw new InvalidConfigPathError('Config path must not be empty.');
  }
  const segments = input.split('.');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new InvalidConfigPathError(
        `Config path "${input}" has an empty segment; check for stray dots.`,
      );
    }
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new InvalidConfigPathError(
        `Config path "${input}" contains the reserved segment "${segment}".`,
      );
    }
  }
  return segments;
}

export function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidConfigPathError(`Value is not valid JSON: ${message}`);
  }
}

/**
 * Walks `root`, copying along the way, and sets `value` at `segments`.
 * Each non-final segment must already point at a plain object so we don't
 * silently invent nested structure that the schema would later reject.
 */
export function setAtPath(
  root: Readonly<Record<string, unknown>>,
  segments: readonly string[],
  value: unknown,
): Record<string, unknown> {
  if (segments.length === 0) {
    throw new InvalidConfigPathError('Config path must not be empty.');
  }
  const next: Record<string, unknown> = { ...root };
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] as string;
    const child = cursor[segment];
    if (!isPlainObject(child)) {
      const traversed = segments.slice(0, i + 1).join('.');
      throw new InvalidConfigPathError(
        `Cannot set "${segments.join('.')}": "${traversed}" is not an object in the current config.`,
      );
    }
    const copy = { ...child };
    cursor[segment] = copy;
    cursor = copy;
  }
  const last = segments[segments.length - 1] as string;
  cursor[last] = value;
  return next;
}

export async function runConfigSet(
  pathInput: string,
  valueInput: string,
  deps: ConfigSetDeps,
  options: ConfigSetOptions,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);

  let segments: string[];
  let value: unknown;
  try {
    segments = parseDottedPath(pathInput);
    value = parseJsonValue(valueInput);
  } catch (error) {
    if (error instanceof InvalidConfigPathError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // The load-modify-validate-write runs under the shared config-dir lock so a
  // concurrent command cannot read the same snapshot and clobber this set (P3-07).
  return withConfigLock(path.dirname(target), async () => {
    let current;
    try {
      current = await loadConfig(target);
    } catch (error) {
      if (error instanceof ConfigLoadError) {
        const cause = error.cause as NodeJS.ErrnoException | undefined;
        if (cause?.code === 'ENOENT') {
          deps.stderr(`No ToolBox config found at ${target}. Run \`tlbx init\` first.\n`);
          return 1;
        }
        deps.stderr(`${error.message}\n`);
        return 1;
      }
      if (error instanceof ConfigValidationError || error instanceof DuplicateKeyError) {
        deps.stderr(`${error.message}\n`);
        return 1;
      }
      throw error;
    }

    let candidate: Record<string, unknown>;
    try {
      candidate = setAtPath(current, segments, value);
    } catch (error) {
      if (error instanceof InvalidConfigPathError) {
        deps.stderr(`${error.message}\n`);
        return 1;
      }
      throw error;
    }

    const result = ToolBoxConfigSchema.safeParse(candidate);
    if (!result.success) {
      deps.stderr(`${new ConfigValidationError(result.error, target).message}\n`);
      return 1;
    }

    await saveConfig(result.data, target);
    deps.stdout(`Set ${segments.join('.')} = ${JSON.stringify(value)} in ${target}\n`);
    return 0;
  });
}

export function configSetCommand(): CommandUnknownOpts {
  return new Command('set')
    .description(
      'Set a config value by dot-notation path. Value is parsed as JSON; ' +
        'the result is re-validated before writing.',
    )
    .argument('<path>', 'dot-notation path, e.g. progressiveDisclosure.enabled')
    .argument('<value>', 'new value, parsed as JSON (e.g. true, "text", 5, [1,2])')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (pathInput, valueInput, opts) => {
      const code = await runConfigSet(pathInput, valueInput, defaultConfigSetDeps(), opts);
      if (code !== 0) {
        process.exit(code);
      }
    });
}
