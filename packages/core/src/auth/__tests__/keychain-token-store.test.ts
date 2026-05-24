import { beforeEach, describe, expect, it } from 'vitest';

import { createNoopLogger } from '../../logging/logger.js';
import { KeychainTokenStore } from '../keychain-token-store.js';
import type { StoredOAuthRecord } from '../token-store.js';

const keyringMock = (() => {
  const passwords = new Map<string, string>();
  const setCalls: Array<{ service: string; account: string; password: string }> = [];
  const deleteCalls: Array<{ service: string; account: string }> = [];
  let setPasswordError: Error | null = null;
  let deletePasswordError: Error | null = null;

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
      deleteCalls.push({ service: this.service, account: this.account });
      if (deletePasswordError !== null) {
        throw deletePasswordError;
      }
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
    deleteCalls,
    reset() {
      passwords.clear();
      setCalls.length = 0;
      deleteCalls.length = 0;
      setPasswordError = null;
      deletePasswordError = null;
    },
    setSetPasswordError(error: Error | null) {
      setPasswordError = error;
    },
    setDeletePasswordError(error: Error | null) {
      deletePasswordError = error;
    },
  };
})();

type TestKeyringModule = {
  Entry: typeof keyringMock.Entry;
  findCredentials?: typeof keyringMock.findCredentials;
};

function rejectLoadKeyring(reason: unknown): Promise<TestKeyringModule> {
  return new Promise((_resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- defensive coverage for native loaders that reject non-Error values
    reject(reason);
  });
}

function makeRecord(overrides: Partial<StoredOAuthRecord> = {}): StoredOAuthRecord {
  return {
    schemaVersion: 2,
    clientInformation: { client_id: 'client-abc' },
    tokens: { access_token: 'access-1', token_type: 'Bearer' },
    authorizationServer: 'https://auth.example.com',
    scopes: ['read'],
    obtainedAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  };
}

function createStore(
  loadKeyring: () => Promise<TestKeyringModule> = () =>
    Promise.resolve({
      Entry: keyringMock.Entry,
      findCredentials: keyringMock.findCredentials,
    }),
) {
  return new KeychainTokenStore({ logger: createNoopLogger(), loadKeyring });
}

describe('KeychainTokenStore', () => {
  beforeEach(() => {
    keyringMock.reset();
  });

  it('throws when deleting from an unavailable keychain', async () => {
    const store = createStore(() => Promise.reject(new Error('libsecret not found')));

    await expect(store.delete('github')).rejects.toThrow(
      /Keychain unavailable: .*libsecret not found/,
    );
  });

  it('throws when writing to an unavailable keychain', async () => {
    const store = createStore(() => Promise.reject(new Error('libsecret not found')));

    await expect(store.write('github', makeRecord())).rejects.toThrow(
      /Keychain unavailable: .*libsecret not found/,
    );
  });

  it('throws when listing from an unavailable keychain', async () => {
    const store = createStore(() => Promise.reject(new Error('libsecret not found')));

    await expect(store.list()).rejects.toThrow(/Keychain unavailable: .*libsecret not found/);
  });

  it('reports unavailable-on-import in probe and fail-loud read operations', async () => {
    const store = createStore(() => Promise.reject(new Error('libsecret not found')));

    const health = await store.probe();
    expect(health.kind).toBe('unavailable');
    if (health.kind === 'unavailable') {
      expect(health.reason).toContain('libsecret not found');
    }
    await expect(store.read('github')).rejects.toThrow(
      /Keychain unavailable: .*libsecret not found/,
    );
  });

  it('reports nested import error causes in unavailable diagnostics', async () => {
    const store = createStore(() => {
      const leaf = new Error('libsecret not found');
      const middle = new Error("Cannot find module '@napi-rs/keyring-linux-arm64-gnu'");
      const top = new Error('Failed to load native binding');
      Object.defineProperty(middle, 'cause', { value: leaf });
      Object.defineProperty(top, 'cause', { value: middle });
      return Promise.reject(top);
    });

    const health = await store.probe();
    expect(health.kind).toBe('unavailable');
    if (health.kind === 'unavailable') {
      expect(health.reason).toContain('Failed to load native binding');
      expect(health.reason).toContain("Cannot find module '@napi-rs/keyring-linux-arm64-gnu'");
      expect(health.reason).toContain('libsecret not found');
    }
  });

  it('reports non-error import failures in unavailable diagnostics', async () => {
    const store = createStore(() => rejectLoadKeyring('keychain disabled'));

    expect(await store.probe()).toEqual({ kind: 'unavailable', reason: 'keychain disabled' });
  });

  it('reports primitive import error causes in unavailable diagnostics', async () => {
    const store = createStore(() => {
      const top = new Error('Failed to load native binding');
      Object.defineProperty(top, 'cause', { value: 13 });
      return Promise.reject(top);
    });

    expect(await store.probe()).toEqual({
      kind: 'unavailable',
      reason: 'Failed to load native binding: 13',
    });
  });

  it('reports object import error causes in unavailable diagnostics', async () => {
    const store = createStore(() => {
      const top = new Error('Failed to load native binding');
      Object.defineProperty(top, 'cause', { value: { code: 'missing-native-binding' } });
      return Promise.reject(top);
    });

    expect(await store.probe()).toEqual({
      kind: 'unavailable',
      reason: 'Failed to load native binding: non-Error cause',
    });
  });

  it('round-trips write then read for the same server', async () => {
    const store = createStore();
    const record = makeRecord();

    await store.write('github', record);

    expect(await store.read('github')).toEqual(record);
  });

  it('preserves full dynamic client registration metadata when reading', async () => {
    const store = createStore();
    const record = makeRecord({
      clientInformation: {
        client_id: 'client-abc',
        redirect_uris: ['https://toolbox.example/oauth/callback'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    });
    keyringMock.passwords.set('dev.toolbox.cli:oauth:github', JSON.stringify(record));

    expect(await store.read('github')).toEqual(record);
  });

  it('loads a pre-resource-indicator v1 record by migrating it forward on read', async () => {
    const store = createStore();
    // A record exactly as F1-13..F1-19 wrote it: schemaVersion 1, no resource.
    keyringMock.passwords.set(
      'dev.toolbox.cli:oauth:github',
      JSON.stringify({
        schemaVersion: 1,
        clientInformation: { client_id: 'client-abc' },
        tokens: { access_token: 'access-1', token_type: 'Bearer' },
        authorizationServer: 'https://auth.example.com',
        scopes: ['read'],
        obtainedAt: '2026-05-19T00:00:00.000Z',
      }),
    );

    const record = await store.read('github');

    expect(record?.schemaVersion).toBe(2);
    expect(record?.resource).toBeUndefined();
    expect(record?.tokens.access_token).toBe('access-1');
  });

  it('uses the ToolBox service name and oauth-prefixed account name', async () => {
    const store = createStore();

    await store.write('github', makeRecord());

    expect(keyringMock.setCalls[0]).toMatchObject({
      service: 'dev.toolbox.cli',
      account: 'oauth:github',
    });
  });

  it('returns null when reading an unknown server', async () => {
    const store = createStore();

    expect(await store.read('unknown')).toBeNull();
  });

  it('throws a contextual error when a stored record is not valid JSON', async () => {
    const store = createStore();
    keyringMock.passwords.set('dev.toolbox.cli:oauth:github', '{not-json');

    await expect(store.read('github')).rejects.toThrow(
      'Keychain entry for github is corrupt: invalid JSON',
    );
  });

  it('throws a contextual error when a stored record does not match the schema', async () => {
    const store = createStore();
    keyringMock.passwords.set(
      'dev.toolbox.cli:oauth:github',
      JSON.stringify({ schemaVersion: 1, clientInformation: { client_id: 'client-abc' } }),
    );

    await expect(store.read('github')).rejects.toThrow(
      'Keychain entry for github is corrupt: stored record does not match schema',
    );
  });

  it('does not throw when deleting a missing server from an available keychain', async () => {
    const store = createStore();

    await expect(store.delete('missing')).resolves.toBeUndefined();
  });

  it('lists oauth accounts only and strips their prefix', async () => {
    const store = createStore();
    await store.write('github', makeRecord());
    await store.write('jira', makeRecord());
    keyringMock.passwords.set('dev.toolbox.cli:not-oauth', 'ignored');
    keyringMock.passwords.set('other.service:oauth:linear', 'ignored');

    expect(new Set(await store.list())).toEqual(new Set(['github', 'jira']));
  });

  it('returns an empty list when keychain enumeration is unsupported', async () => {
    const store = createStore(() => Promise.resolve({ Entry: keyringMock.Entry }));

    expect(await store.list()).toEqual([]);
  });

  it('probe returns ready for a working keychain', async () => {
    const store = createStore();

    expect(await store.probe()).toEqual({ kind: 'ready' });
    expect(keyringMock.setCalls[0]?.account).toMatch(/^probe:_probe_/);
  });

  it('probe returns unavailable with the reason when the keychain write fails', async () => {
    keyringMock.setSetPasswordError(new Error('permission denied'));
    const store = createStore();

    expect(await store.probe()).toEqual({ kind: 'unavailable', reason: 'permission denied' });
  });

  it('probe retries cleanup and reports unavailable when deleting the sentinel fails', async () => {
    keyringMock.setDeletePasswordError(new Error('delete denied'));
    const store = createStore();

    expect(await store.probe()).toEqual({ kind: 'unavailable', reason: 'delete denied' });
    expect(keyringMock.setCalls[0]?.account).toMatch(/^probe:_probe_/);
    expect(keyringMock.deleteCalls).toHaveLength(2);
    expect(await store.list()).toEqual([]);
  });
});
