import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNoopLogger,
  CREDENTIAL_LOCK_DIR_ENV,
  InMemoryTokenStore,
  loadConfig,
  resolveCredentialLockRoot,
  saveConfig,
  ToolBoxOAuthProvider,
  type AuthHint,
  type RunOAuthLoginInput,
  type RunOAuthLoginResult,
  type StoredOAuthRecord,
  type TokenStore,
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
  vi.unstubAllEnvs();
});

/**
 * Roots the credential lock under the test's temp dir instead of the real
 * machine-global location, so the run stays isolated while the CLI commands and
 * the provider (which resolve the root the same way) still serialize on it.
 */
function isolateCredentialLock(cfg: ConfigHarness): void {
  vi.stubEnv(CREDENTIAL_LOCK_DIR_ENV, cfg.dir);
}

const KEYCHAIN_STORAGE = { type: 'keychain' } as const;

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
    isolateCredentialLock(cfg);
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
    isolateCredentialLock(cfg);
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

describe('gateway token refresh racing auth logout (P3-09)', () => {
  it('cannot resurrect a token: logout waits for the in-flight refresh save, then deletes', async () => {
    // The gateway's OAuth provider persists an SDK-driven refresh through the
    // same per-name credential lock the CLI holds. A logout started while that
    // save is mid read-modify-write must wait for it and then delete — never
    // slip its delete between the save's read and write (which would let the
    // write re-create the credential the user just removed).
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    isolateCredentialLock(cfg);
    const backing = new InMemoryTokenStore();
    await backing.write('acme', record);

    let releaseRead = (): void => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let signalReadInFlight = (): void => undefined;
    const readInFlight = new Promise<void>((resolve) => {
      signalReadInFlight = resolve;
    });
    let gateArmed = true;
    const gatedStore: TokenStore = {
      read: async (name) => {
        if (gateArmed) {
          gateArmed = false;
          signalReadInFlight();
          await readGate;
        }
        return backing.read(name);
      },
      write: (name, rec) => backing.write(name, rec),
      delete: (name) => backing.delete(name),
      list: () => backing.list(),
      probe: () => backing.probe(),
    };
    const provider = new ToolBoxOAuthProvider({
      serverName: 'acme',
      redirectUrl: new URL('http://127.0.0.1:0/unused'),
      tokenStore: gatedStore,
      logger: createNoopLogger(),
      // Resolve the lock root the same way the CLI commands do, so the provider's
      // refresh save and the real `runAuthLogout` below contend on one lock.
      credentialLockRoot: resolveCredentialLockRoot(KEYCHAIN_STORAGE),
    });

    // The refresh save acquires the lock, then stalls inside its locked read.
    const savePromise = provider.saveTokens(newRecord.tokens);
    await readInFlight;

    // Real logout for the same name, with a store sharing the same backing.
    const logoutPromise = runAuthLogout('acme', {}, authDeps(cfg.target, backing));
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseRead();

    const [, logoutCode] = await Promise.all([savePromise, logoutPromise]);
    expect(logoutCode).toBe(0);
    // Logout ran last under the lock: the refreshed token does not survive it.
    expect(await backing.read('acme')).toBeNull();
  });
});

describe('cross-config same-credential serialization (P3-10)', () => {
  it('serializes two commands that target the same credential from different config dirs', async () => {
    // The keychain record is machine-global, so two invocations run against
    // *different* config files (`-c prod.json` vs `-c staging.json`) still mutate
    // the same credential and must serialize. Pre-P3-10 the lock was rooted at
    // each invocation's config dir, so these two would have locked different
    // dirs and interleaved. Here add-http (config A) holds the credential lock
    // across its login while logout (config B) for the same name must wait —
    // proving the lock domain ignores the config path.
    const cfgA = await makeTempConfig();
    const cfgB = await makeTempConfig();
    harnesses.push(cfgA, cfgB);

    // A shared credential-lock base independent of either config dir — standing
    // in for the real machine-global location both invocations would resolve to.
    const lockBase = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-cred-lock-base-'));
    vi.stubEnv(CREDENTIAL_LOCK_DIR_ENV, lockBase);
    expect(resolveCredentialLockRoot(KEYCHAIN_STORAGE)).toContain(lockBase);

    // One backing store stands in for the single machine-global keychain both
    // configs reach.
    const store = new InMemoryTokenStore();
    await store.write('acme', record);

    try {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // `runOAuthLogin` runs *inside* the credential lock, so its invocation is a
      // deterministic "add now holds the lock" signal — no sleep-and-hope.
      let signalHeld = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      const add = addDeps(cfgA.target, store);
      add.runOAuthLogin = vi.fn(async (input: RunOAuthLoginInput): Promise<RunOAuthLoginResult> => {
        signalHeld();
        await gate;
        await input.tokenStore.write(input.serverName, newRecord);
        return { kind: 'success' };
      });

      const addPromise = runAddHttp('acme', { url: 'https://acme.test/mcp', auth: 'oauth' }, add);
      // add provably holds the credential lock for "acme" once login is reached.
      await held;

      // Logout for the SAME name but a DIFFERENT config file must block on add's
      // credential lock rather than slip through on a separate per-config lock.
      let logoutSettled = false;
      const logoutPromise = runAuthLogout('acme', {}, authDeps(cfgB.target, store)).then((code) => {
        logoutSettled = true;
        return code;
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(logoutSettled).toBe(false);

      // Releasing add lets it finish under the lock, after which logout proceeds.
      release();
      const [addCode, logoutCode] = await Promise.all([addPromise, logoutPromise]);

      expect(addCode).toBe(0);
      expect(logoutCode).toBe(0);
      // Logout ran strictly after add released the lock, so the token add wrote
      // does not survive — no interleaving despite the distinct config dirs.
      expect(await store.read('acme')).toBeNull();
      // Each config file is independent: add registered acme in A only.
      expect((await loadConfig(cfgA.target)).servers.acme).toBeDefined();
      expect((await loadConfig(cfgB.target)).servers.acme).toBeUndefined();
    } finally {
      await fs.rm(lockBase, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
