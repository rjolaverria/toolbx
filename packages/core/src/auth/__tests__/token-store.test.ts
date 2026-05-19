import { describe, expect, it } from 'vitest';

import { InMemoryTokenStore, type StoredOAuthRecord } from '../token-store.js';

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

describe('InMemoryTokenStore', () => {
  it('returns null when reading an unknown server', async () => {
    const store = new InMemoryTokenStore();
    expect(await store.read('jira')).toBeNull();
  });

  it('round-trips write then read for the same server', async () => {
    const store = new InMemoryTokenStore();
    const record = makeRecord();
    await store.write('jira', record);
    expect(await store.read('jira')).toEqual(record);
  });

  it('write overwrites the previous record for the same server', async () => {
    const store = new InMemoryTokenStore();
    await store.write('jira', makeRecord({ obtainedAt: '2026-05-18T00:00:00.000Z' }));
    const second = makeRecord({ obtainedAt: '2026-05-19T00:00:00.000Z' });
    await store.write('jira', second);
    expect(await store.read('jira')).toEqual(second);
    expect(await store.list()).toEqual(['jira']);
  });

  it('delete removes the record and subsequent read returns null', async () => {
    const store = new InMemoryTokenStore();
    await store.write('jira', makeRecord());
    await store.delete('jira');
    expect(await store.read('jira')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('delete on an unknown server is a no-op', async () => {
    const store = new InMemoryTokenStore();
    await expect(store.delete('ghost')).resolves.toBeUndefined();
  });

  it('list reflects the current keyset (order not guaranteed)', async () => {
    const store = new InMemoryTokenStore();
    await store.write('jira', makeRecord());
    await store.write('github', makeRecord());
    expect(new Set(await store.list())).toEqual(new Set(['jira', 'github']));
  });

  it('probe reports ready', async () => {
    const store = new InMemoryTokenStore();
    expect(await store.probe()).toEqual({ kind: 'ready' });
  });
});
