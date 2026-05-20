import { describe, expect, it, vi } from 'vitest';

import type { TokenStorage } from '../../config/schema.js';
import { createNoopLogger } from '../../logging/logger.js';
import { createTokenStore } from '../token-store-factory.js';

class MockEntry {
  getPassword(): string | null {
    return null;
  }

  setPassword(): void {}

  deletePassword(): boolean {
    return true;
  }
}

vi.mock('@napi-rs/keyring', () => ({ Entry: MockEntry }));

// The exhaustiveness check inside `createTokenStore` is enforced at compile
// time. While `TokenStorage` has only one variant, the factory pins
// `storage.type` to the literal `'keychain'`; when F1-14 (or later) adds a
// second variant, that assignment fails `pnpm typecheck` and forces the
// switch to handle it. There is no runtime test for this — typecheck is.

describe('createTokenStore', () => {
  it('creates a probeable keychain token store for the keychain backend', async () => {
    const storage: TokenStorage = { type: 'keychain' };
    const store = createTokenStore(storage, { logger: createNoopLogger() });
    expect(await store.probe()).toEqual({ kind: 'ready' });
  });
});
