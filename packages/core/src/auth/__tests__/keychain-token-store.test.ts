import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createNoopLogger } from '../../logging/logger.js';
import type { StoredOAuthRecord } from '../token-store.js';

const keyringMock = vi.hoisted(() => {
  const passwords = new Map<string, string>();
  const setCalls: Array<{ service: string; account: string; password: string }> = [];
  let setPasswordError: Error | null = null;

  class MockEntry {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}

    getPassword(): string | null {
      return passwords.get(`${this.service}:${this.account}`) ?? null;
    }

    setPassword(password: string): void {
      setCalls.push({ service: this.service, account: this.account, password });
      if (setPasswordError !== null) {
        throw setPasswordError;
      }
      passwords.set(`${this.service}:${this.account}`, password);
    }

    deletePassword(): boolean {
      return passwords.delete(`${this.service}:${this.account}`);
    }
  }

  function findCredentials(service: string): Array<{ account: string; password: string }> {
    const prefix = `${service}:`;
    return [...passwords.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, password]) => ({ account: key.slice(prefix.length), password }));
  }

  return {
    Entry: MockEntry,
    findCredentials,
    passwords,
    setCalls,
    reset() {
      passwords.clear();
      setCalls.length = 0;
      setPasswordError = null;
    },
    setSetPasswordError(error: Error | null) {
      setPasswordError = error;
    },
  };
});

vi.mock('@napi-rs/keyring', () => ({
  Entry: keyringMock.Entry,
  findCredentials: keyringMock.findCredentials,
}));

function makeRecord(overrides: Partial<StoredOAuthRecord> = {}): StoredOAuthRecord {
  return {
    schemaVersion: 1,
    clientInformation: { client_id: 'client-abc' },
    tokens: { access_token: 'access-1', token_type: 'Bearer' },
    authorizationServer: 'https://auth.example.com',
    scopes: ['read'],
    obtainedAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  };
}

async function createStore() {
  const { KeychainTokenStore } = await import('../keychain-token-store.js');
  return new KeychainTokenStore({ logger: createNoopLogger() });
}

describe('KeychainTokenStore', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@napi-rs/keyring', () => ({
      Entry: keyringMock.Entry,
      findCredentials: keyringMock.findCredentials,
    }));
    keyringMock.reset();
  });

  it('throws when deleting from an unavailable keychain', async () => {
    vi.resetModules();
    vi.doMock('@napi-rs/keyring', () => {
      throw new Error('libsecret not found');
    });
    const store = await createStore();

    await expect(store.delete('github')).rejects.toThrow(
      'Keychain unavailable: libsecret not found',
    );
  });

  it('throws when listing from an unavailable keychain', async () => {
    vi.resetModules();
    vi.doMock('@napi-rs/keyring', () => {
      throw new Error('libsecret not found');
    });
    const store = await createStore();

    await expect(store.list()).rejects.toThrow('Keychain unavailable: libsecret not found');
  });

  it('reports unavailable-on-import in probe and fail-loud read operations', async () => {
    vi.resetModules();
    vi.doMock('@napi-rs/keyring', () => {
      throw new Error('libsecret not found');
    });
    const store = await createStore();

    expect(await store.probe()).toEqual({ kind: 'unavailable', reason: 'libsecret not found' });
    await expect(store.read('github')).rejects.toThrow('Keychain unavailable: libsecret not found');
  });

  it('round-trips write then read for the same server', async () => {
    const store = await createStore();
    const record = makeRecord();

    await store.write('github', record);

    expect(await store.read('github')).toEqual(record);
  });

  it('uses the ToolBox service name and oauth-prefixed account name', async () => {
    const store = await createStore();

    await store.write('github', makeRecord());

    expect(keyringMock.setCalls[0]).toMatchObject({
      service: 'dev.toolbox.cli',
      account: 'oauth:github',
    });
  });

  it('returns null when reading an unknown server', async () => {
    const store = await createStore();

    expect(await store.read('unknown')).toBeNull();
  });

  it('does not throw when deleting a missing server from an available keychain', async () => {
    const store = await createStore();

    await expect(store.delete('missing')).resolves.toBeUndefined();
  });

  it('lists oauth accounts only and strips their prefix', async () => {
    const store = await createStore();
    await store.write('github', makeRecord());
    await store.write('jira', makeRecord());
    keyringMock.passwords.set('dev.toolbox.cli:not-oauth', 'ignored');
    keyringMock.passwords.set('other.service:oauth:linear', 'ignored');

    expect(new Set(await store.list())).toEqual(new Set(['github', 'jira']));
  });

  it('probe returns ready for a working keychain', async () => {
    const store = await createStore();

    expect(await store.probe()).toEqual({ kind: 'ready' });
  });

  it('probe returns unavailable with the reason when the keychain write fails', async () => {
    keyringMock.setSetPasswordError(new Error('permission denied'));
    const store = await createStore();

    expect(await store.probe()).toEqual({ kind: 'unavailable', reason: 'permission denied' });
  });
});
