import * as fs from 'node:fs/promises';
import { z } from 'zod';

import { DuplicateKeyError, findDuplicateKeys } from './duplicate-keys.js';
import { resolveConfigPath } from './paths.js';
import { ToolBoxConfigSchema, type ToolBoxConfig } from './schema.js';

export interface ConfigLoadErrorOptions {
  source?: string | undefined;
  cause?: unknown;
}

export class ConfigLoadError extends Error {
  override readonly name = 'ConfigLoadError';
  readonly source: string | undefined;

  constructor(message: string, options: ConfigLoadErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.source = options.source;
  }
}

export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError';
  readonly issues: readonly z.core.$ZodIssue[];
  readonly source: string | undefined;

  constructor(zodError: z.ZodError, source?: string) {
    super(formatValidationMessage(zodError, source));
    this.issues = zodError.issues;
    this.source = source;
  }
}

function formatValidationMessage(zodError: z.ZodError, source: string | undefined): string {
  const where = source !== undefined ? ` in ${source}` : '';
  const issues = zodError.issues
    .map((issue) => {
      const pointer = issue.path.length === 0 ? '<root>' : '/' + issue.path.map(String).join('/');
      return `  - ${pointer}: ${issue.message}`;
    })
    .join('\n');
  return `Invalid ToolBox config${where}:\n${issues}`;
}

export function parseConfig(source: string, sourceLabel?: string): ToolBoxConfig {
  const duplicates = findDuplicateKeys(source);
  if (duplicates.length > 0) {
    throw new DuplicateKeyError(duplicates, sourceLabel);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigLoadError(
      `Failed to parse ToolBox config${sourceLabel !== undefined ? ` at ${sourceLabel}` : ''}: ${message}`,
      { source: sourceLabel, cause: error },
    );
  }

  const result = ToolBoxConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigValidationError(result.error, sourceLabel);
  }
  return result.data;
}

export async function loadConfig(filePath?: string): Promise<ToolBoxConfig> {
  const resolved = filePath ?? resolveConfigPath();
  let source: string;
  try {
    source = await fs.readFile(resolved, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigLoadError(`Failed to read ToolBox config at ${resolved}: ${message}`, {
      source: resolved,
      cause: error,
    });
  }
  return parseConfig(source, resolved);
}
