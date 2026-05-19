import type { TokenStorage } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';

import type { TokenStore } from './token-store.js';

export interface CreateTokenStoreDeps {
  logger: Logger;
}

/**
 * The only place in the codebase that switches on `storage.type`. Every other
 * consumer receives an opaque `TokenStore` and never inspects which backend
 * powers it.
 */
export function createTokenStore(storage: TokenStorage, deps: CreateTokenStoreDeps): TokenStore {
  // `deps` is part of the factory's public surface — F1-14 will start using
  // `deps.logger` to log backend startup. Touch it here so the compiler/linter
  // sees the parameter as referenced today.
  void deps;
  switch (storage.type) {
    case 'keychain':
      // F1-14 will replace this throw with a real instantiation.
      throw new Error(
        'KeychainTokenStore not yet implemented (F1-14). ' +
          'Use InMemoryTokenStore in tests until then.',
      );
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
