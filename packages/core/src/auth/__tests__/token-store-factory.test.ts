import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { TokenStorage } from '../../config/schema.js';
import { createNoopLogger } from '../../logging/logger.js';
import { KEYCHAIN_SERVICE_NAME } from '../keychain-token-store.js';
import {
  CREDENTIAL_LOCK_DIR_ENV,
  createTokenStore,
  resolveCredentialLockRoot,
} from '../token-store-factory.js';

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

describe('resolveCredentialLockRoot', () => {
  const keychain: TokenStorage = { type: 'keychain' };

  it('roots the keychain lock at a machine-global location independent of any config dir', () => {
    // The keychain record is machine-global (one fixed service name, keyed only
    // by server name), so the lock domain must not depend on which config the
    // command was invoked with. The resolver takes no config dir at all, and the
    // root is the same across invocations.
    const root = resolveCredentialLockRoot(keychain, {});
    expect(root).toBe(path.join(tmpdir(), 'toolbox-credential-locks', KEYCHAIN_SERVICE_NAME));
    expect(resolveCredentialLockRoot(keychain, {})).toBe(root);
  });

  it('honors the lock-dir env override as a test seam', () => {
    const base = '/tmp/toolbox-lock-test';
    expect(resolveCredentialLockRoot(keychain, { [CREDENTIAL_LOCK_DIR_ENV]: base })).toBe(
      path.join(base, 'toolbox-credential-locks', KEYCHAIN_SERVICE_NAME),
    );
  });
});
