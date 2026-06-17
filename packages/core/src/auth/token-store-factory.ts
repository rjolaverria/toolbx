import { homedir, userInfo } from 'node:os';
import * as path from 'node:path';

import type { TokenStorage } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';

import { KEYCHAIN_SERVICE_NAME, KeychainTokenStore } from './keychain-token-store.js';
import type { TokenStore } from './token-store.js';

export interface CreateTokenStoreDeps {
  logger: Logger;
}

/**
 * Env override for the credential-lock base directory. Tests point this at a
 * temp dir so they never contend on — or write into — the real per-user lock
 * location; production leaves it unset and falls back to {@link credentialLockHome}.
 */
export const CREDENTIAL_LOCK_DIR_ENV = 'TOOLBOX_CREDENTIAL_LOCK_DIR';

/**
 * Per-user base for the credential lock, deliberately **independent of the
 * temp-dir environment**. `os.tmpdir()` reads `TMPDIR`/`TMP`/`TEMP`, which differ
 * between processes of the same user — most notably a launchd-started gateway
 * daemon (often no `TMPDIR`, so `/tmp`) versus a terminal CLI (a per-user
 * `/var/folders/.../T`). Two such processes mutate the same keychain record but
 * would resolve different temp-rooted lock dirs, reintroducing the very race
 * P3-10 closes. The OS keychain is scoped to the login user, so anchor the lock
 * at that user's home from the account database (`userInfo()`, which ignores
 * `$HOME` on POSIX), falling back to {@link homedir} only when the account entry
 * cannot be read (e.g. a minimal container).
 */
function credentialLockHome(): string {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
}

/**
 * Resolves the credential-lock root for a token-store backend, so the advisory
 * lock that serializes a credential's read-modify-write shares one domain with
 * the record it protects.
 *
 * The keychain backend is **per-user, machine-global**: every record lives under
 * the one fixed service name ({@link KEYCHAIN_SERVICE_NAME}), keyed only by
 * server name, regardless of which `config.json` reached it. Anchoring the lock
 * under the per-invocation config dir (the pre-P3-10 behavior) therefore let two
 * commands run with different `-c` paths mutate the *same* keychain record
 * without serializing. Rooting the lock at a fixed, config-independent location
 * (and one that does not vary with the temp-dir env across processes) means any
 * two invocations that touch the same stored credential contend on the same lock
 * no matter how they were invoked.
 *
 * The base is the per-user {@link credentialLockHome}; {@link CREDENTIAL_LOCK_DIR_ENV}
 * overrides it as a test seam. Both are POSIX- and Windows-sane.
 */
export function resolveCredentialLockRoot(
  storage: TokenStorage,
  env: NodeJS.ProcessEnv = process.env,
): string {
  switch (storage.type) {
    case 'keychain': {
      const base = env[CREDENTIAL_LOCK_DIR_ENV] ?? path.join(credentialLockHome(), '.toolbox');
      return path.join(base, 'credential-locks', KEYCHAIN_SERVICE_NAME);
    }
  }
  // Compile-time exhaustiveness, mirroring `createTokenStore`: this single-arm
  // switch fails to compile the moment a new `TokenStorage` variant lands,
  // forcing a deliberate decision about that backend's lock domain.
  const exhaustive: 'keychain' = storage.type;
  throw new Error(`Unknown token storage type: ${JSON.stringify(exhaustive)}`);
}

/**
 * The only place in the codebase that switches on `storage.type`. Every other
 * consumer receives an opaque `TokenStore` and never inspects which backend
 * powers it.
 */
export function createTokenStore(storage: TokenStorage, deps: CreateTokenStoreDeps): TokenStore {
  switch (storage.type) {
    case 'keychain':
      return new KeychainTokenStore({ logger: deps.logger });
  }
  // Compile-time exhaustiveness. `TokenStorage` currently has a single
  // variant, so the canonical `const _exhaustive: never = storage` pattern
  // does not apply yet — TypeScript only narrows a discriminated union to
  // `never` once it has at least two variants. The assignment below fails as
  // soon as a new variant (e.g. `file`) lands in `TokenStorage['type']`,
  // forcing this switch to be updated. The runtime throw is defensive
  // against inputs that bypass the Zod schema.
  const exhaustive: 'keychain' = storage.type;
  throw new Error(`Unknown token storage type: ${JSON.stringify(exhaustive)}`);
}
