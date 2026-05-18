import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';
import { createOpencodeAdapter } from './opencode.js';
import type { ClientAdapter, ClientAdapterEnv, DetectedClient } from './types.js';

/**
 * Builds the list of client adapters available in the current build. Adapters
 * are listed in detection order. Keeping the registry inside `detectClients`
 * (rather than a module-level constant) lets callers inject test-only
 * environment overrides without touching a shared singleton.
 */
function buildAdapters(env: ClientAdapterEnv): ClientAdapter[] {
  return [createClaudeAdapter(env), createCodexAdapter(env), createOpencodeAdapter(env)];
}

/**
 * Probes each known client adapter and returns the ones whose configuration
 * files exist. Pure-function shape so the future Electron app can poll it on
 * a timer without managing side effects.
 *
 * Tolerant of per-adapter detection errors: if one adapter throws (e.g. a
 * symlink loop, EACCES, or any other non-ENOENT stat error), the other
 * adapters' results still come through. Without this, a single broken
 * client config would abort `tlbx setup` even when the user only asked us
 * to wire a different client.
 */
export async function detectClients(env: ClientAdapterEnv = {}): Promise<DetectedClient[]> {
  const adapters = buildAdapters(env);
  const settled = await Promise.allSettled(adapters.map((adapter) => adapter.detect()));
  const detected: DetectedClient[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value !== null) {
      detected.push(result.value);
    }
  }
  return detected;
}
