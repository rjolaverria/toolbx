import { describe, expect, it } from 'vitest';

import type { TokenStorage } from '../../config/schema.js';
import { createNoopLogger } from '../../logging/logger.js';
import { createTokenStore } from '../token-store-factory.js';

// The exhaustiveness check inside `createTokenStore` is enforced at compile
// time. While `TokenStorage` has only one variant, the factory pins
// `storage.type` to the literal `'keychain'`; when F1-14 (or later) adds a
// second variant, that assignment fails `pnpm typecheck` and forces the
// switch to handle it. There is no runtime test for this — typecheck is.

describe('createTokenStore', () => {
  it('throws the "not yet implemented" error for the keychain backend (F1-14)', () => {
    const storage: TokenStorage = { type: 'keychain' };
    expect(() => createTokenStore(storage, { logger: createNoopLogger() })).toThrow(
      /KeychainTokenStore not yet implemented \(F1-14\)/,
    );
  });
});
