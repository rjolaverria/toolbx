import { createClaudeAdapter } from './claude.js';
import type { ClientAdapter, ClientAdapterEnv, DetectedClient } from './types.js';

/**
 * Builds the list of client adapters available in the current build.
 *
 * Adapters are listed in detection order. F1-08 ships Claude Code only; F1-09
 * adds Codex and OpenCode. Keeping the registry inside `detectClients` (rather
 * than a module-level constant) lets callers inject test-only environment
 * overrides without touching a shared singleton.
 */
function buildAdapters(env: ClientAdapterEnv): ClientAdapter[] {
  return [createClaudeAdapter(env)];
}

/**
 * Probes each known client adapter and returns the ones whose configuration
 * files exist. Pure-function shape so the future Electron app can poll it on
 * a timer without managing side effects.
 */
export async function detectClients(env: ClientAdapterEnv = {}): Promise<DetectedClient[]> {
  const adapters = buildAdapters(env);
  const results = await Promise.all(adapters.map((adapter) => adapter.detect()));
  return results.filter((result): result is DetectedClient => result !== null);
}
