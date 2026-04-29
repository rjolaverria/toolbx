import { UpstreamMissingEnvVarError } from './errors.js';

const ENV_PLACEHOLDER_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface ResolveEnvOptions {
  /** The user-supplied env map from the server config (after Zod parsing). */
  env?: Record<string, string> | undefined;
  /** Process env to look up placeholder values in. Defaults to `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
  /** Optional server name, included in error messages. */
  serverName?: string;
}

/**
 * Resolve `${env:VAR}` placeholders in env values, throwing
 * `UpstreamMissingEnvVarError` if any referenced variable is unset.
 *
 * Returns a new map; the input is not mutated. Returns `undefined` when no env
 * map was provided so callers can distinguish "no env override" from "empty
 * env override".
 */
export function resolveEnvPlaceholders(
  options: ResolveEnvOptions,
): Record<string, string> | undefined {
  const { env, serverName } = options;
  if (env === undefined) {
    return undefined;
  }
  const processEnv = options.processEnv ?? process.env;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = replacePlaceholders(value, processEnv, serverName);
  }
  return resolved;
}

function replacePlaceholders(
  value: string,
  processEnv: NodeJS.ProcessEnv,
  serverName: string | undefined,
): string {
  return value.replace(ENV_PLACEHOLDER_RE, (_match, varName: string) => {
    const found = processEnv[varName];
    if (found === undefined) {
      throw new UpstreamMissingEnvVarError(varName, serverName);
    }
    return found;
  });
}
