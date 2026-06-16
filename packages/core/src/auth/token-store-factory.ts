import { tmpdir } from 'node:os';
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
 * temp dir so they never contend on — or write into — the real machine-global
 * lock location; production leaves it unset and falls back to {@link tmpdir}.
 */
export const CREDENTIAL_LOCK_DIR_ENV = 'TOOLBOX_CREDENTIAL_LOCK_DIR';

/**
 * Resolves the credential-lock root for a token-store backend, so the advisory
 * lock that serializes a credential's read-modify-write shares one domain with
 * the record it protects.
 *
 * The keychain backend is **machine-global**: every record lives under the one
 * fixed service name ({@link KEYCHAIN_SERVICE_NAME}), keyed only by server name,
 * regardless of which `config.json` reached it. Anchoring the lock under the
 * per-invocation config dir (the pre-P3-10 behavior) therefore let two commands
 * run with different `-c` paths mutate the *same* keychain record without
 * serializing. Rooting the lock at a fixed, config-independent location instead
 * means any two invocations that touch the same stored credential contend on the
 * same lock no matter how they were invoked.
 *
 * The base directory is {@link tmpdir} (machine-global and writable on both POSIX
 * and Windows; advisory locks are ephemeral runtime state, so a temp location
 * that may be cleared between reboots is correct). The {@link CREDENTIAL_LOCK_DIR_ENV}
 * env var overrides it as a test seam.
 */
export function resolveCredentialLockRoot(
  storage: TokenStorage,
  env: NodeJS.ProcessEnv = process.env,
): string {
  switch (storage.type) {
    case 'keychain': {
      const base = env[CREDENTIAL_LOCK_DIR_ENV] ?? tmpdir();
      return path.join(base, 'toolbox-credential-locks', KEYCHAIN_SERVICE_NAME);
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
