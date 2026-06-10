import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNoopLogger,
  InMemoryTokenStore,
  loadConfig,
  saveConfig,
  type AuthHint,
  type RunOAuthLoginInput,
  type RunOAuthLoginResult,
  type StoredOAuthRecord,
} from '@toolbox/core';

import { runAuthLogout } from '../auth/logout.js';
import type { AuthCommandDeps } from '../auth/shared.js';
import { runAddHttp, type ServerAddDeps } from '../server-add.js';
import { makeTempConfig, type ConfigHarness } from './harness.js';

const harnesses: ConfigHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup();
  }
});

const record: StoredOAuthRecord = {
  schemaVersion: 2,
  clientInformation: { client_id: 'cid' },
  tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' },
  authorizationServer: 'https://acme.test',
  scopes: [],
  obtainedAt: '2026-05-21T00:00:00.000Z',
};

const newRecord: StoredOAuthRecord = {
  ...record,
  tokens: { access_token: 'new', token_type: 'Bearer', refresh_token: 'new-r' },
};

/** Server-add deps sharing one token store and config target, with a slow login
 * that writes `newRecord` after a delay (widening the race window). */
function addDeps(target: string, store: InMemoryTokenStore): ServerAddDeps {
  return {
    resolvePath: () => target,
    cwd: () => path.dirname(target),
    stdout: () => undefined,
    stderr: () => undefined,
    logger: createNoopLogger(),
    createTokenStore: () => store,
    probeAuth: vi.fn(() => Promise.resolve<AuthHint>({ kind: 'oauth' })),
    runOAuthLogin: vi.fn(async (input: RunOAuthLoginInput): Promise<RunOAuthLoginResult> => {
      await new Promise((r) => setTimeout(r, 30));
      await input.tokenStore.write(input.serverName, newRecord);
      return { kind: 'success' };
    }),
    saveConfig: (config, file) => saveConfig(config, file),
  };
}

/** Auth-command deps sharing the same store + target. */
function authDeps(target: string, store: InMemoryTokenStore): AuthCommandDeps {
  return {
    resolvePath: () => target,
    cwd: () => path.dirname(target),
    stdout: () => undefined,
    stderr: () => undefined,
    logger: createNoopLogger(),
    createTokenStore: () => store,
    probeAuth: () => Promise.resolve<AuthHint>({ kind: 'oauth' }),
    runOAuthLogin: () => Promise.reject(new Error('runOAuthLogin not stubbed')),
    runOAuthRefresh: () => Promise.reject(new Error('runOAuthRefresh not stubbed')),
  };
}

describe('add-http OAuth racing auth logout', () => {
  it('rolls back cleanly without resurrecting a logged-out token when the config write fails', async () => {
    // A pre-existing (orphan) token exists. add-http snapshots it, logs in, then
    // its config write FAILS, so it rolls the token store back. Concurrently a
    // logout for the same name runs. Without serialization, add's rollback could
    // restore the token the user just logged out (resurrection). With the
    // per-name credential lock the two cannot interleave, so whichever order they
    // take, the end state is the same: no server registered, no token stored.
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const store = new InMemoryTokenStore();
    await store.write('acme', record);

    const add = addDeps(cfg.target, store);
    add.saveConfig = vi.fn(() => Promise.reject(new Error('disk full')));
    const logout = authDeps(cfg.target, store);

    const [addCode, logoutCode] = await Promise.all([
      runAddHttp('acme', { url: 'https://acme.test/mcp', auth: 'oauth' }, add),
      runAuthLogout('acme', {}, logout),
    ]);

    // add's config write always fails, so it never registers the server.
    expect(addCode).not.toBe(0);
    expect(logoutCode).toBe(0);
    const config = await loadConfig(cfg.target);
    expect(config.servers.acme).toBeUndefined();
    // No resurrection and no orphan: the token is gone in every serialization.
    expect(await store.read('acme')).toBeNull();
  });

  it('does not block a logout for a different name while a login is in progress', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const store = new InMemoryTokenStore();
    await store.write('other', record);

    // add-http for "acme" holds the credential lock across a login that only
    // resolves when we release the gate.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const add = addDeps(cfg.target, store);
    add.runOAuthLogin = vi.fn(async (input: RunOAuthLoginInput): Promise<RunOAuthLoginResult> => {
      await gate;
      await input.tokenStore.write(input.serverName, newRecord);
      return { kind: 'success' };
    });

    const addPromise = runAddHttp('acme', { url: 'https://acme.test/mcp', auth: 'oauth' }, add);
    // Give add a tick to acquire the "acme" credential lock.
    await new Promise((r) => setTimeout(r, 10));

    // A logout for a DIFFERENT name must not wait on acme's in-progress login.
    const logout = authDeps(cfg.target, store);
    const logoutCode = await runAuthLogout('other', {}, logout);

    expect(logoutCode).toBe(0);
    expect(await store.read('other')).toBeNull();

    release();
    await addPromise;
  });
});
