# F1-14 — KeychainTokenStore

**Milestone**: Phase 1 follow-up (OAuth upstream auth, storage backend)
**SPECS references**: §4.6.2 (Upstream OAuth 2.1 auth — keychain decision, native-dep isolation, fail-loud requirement)
**Depends on**: F1-13

## Goal

The first real `TokenStore` backend: stores OAuth records in the OS keychain via `@napi-rs/keyring`. Loaded by dynamic import so non-keychain consumers don't pull the native module. Maps every keyring error variant to a structured `TokenStoreHealth` result so the CLI and `tlbx doctor` can give a precise diagnostic.

## Motivation

SPECS §4.6.2 commits to keychain as the Phase-1-only storage backend, with a fail-loud rule when no secret service is available. The user explicitly chose keychain over plain-file fallback during the brainstorm. This task makes that decision real.

## Deliverables

- **`packages/core/package.json`** — add `@napi-rs/keyring` as an **optional dependency**, not a required one:

  ```json
  "optionalDependencies": {
    "@napi-rs/keyring": "^1.x"  // pin to the latest stable major at task-execution time
  }
  ```

  Reasoning: an install on a Linux system without libsecret should not break `pnpm install` — `tlbx doctor` will report keychain unavailability at runtime instead. Verify the install behavior in the test plan below.

- **`packages/core/src/auth/keychain-token-store.ts`** — new file. Public surface:

  ```ts
  import type { Logger } from '../logging/logger.js';
  import type { StoredOAuthRecord, TokenStore, TokenStoreHealth } from './token-store.js';

  const SERVICE_NAME = 'dev.toolbox.cli';
  const ACCOUNT_PREFIX = 'oauth:';

  function accountFor(serverName: string): string {
    return `${ACCOUNT_PREFIX}${serverName}`;
  }

  /**
   * Dynamically-imported keyring API surface. Hand-typed so the rest of the
   * module compiles even when @napi-rs/keyring isn't installed (optional dep).
   */
  type KeyringEntryCtor = new (
    service: string,
    account: string,
  ) => {
    getPassword(): string | null;
    setPassword(password: string): void;
    deletePassword(): boolean;
    findCredentials?: () => Array<{ account: string; password: string }>;
  };

  type KeyringModule = { Entry: KeyringEntryCtor };

  async function loadKeyring(): Promise<KeyringModule | { kind: 'missing'; reason: string }> {
    try {
      // Dynamic import so consumers that don't instantiate KeychainTokenStore
      // never pull the native module.
      const mod = (await import('@napi-rs/keyring')) as KeyringModule;
      return mod;
    } catch (err) {
      return {
        kind: 'missing',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  export interface KeychainTokenStoreDeps {
    logger: Logger;
  }

  export class KeychainTokenStore implements TokenStore {
    private keyringPromise: Promise<KeyringModule | { kind: 'missing'; reason: string }> | null =
      null;
    constructor(private readonly deps: KeychainTokenStoreDeps) {}

    private async keyring(): Promise<KeyringModule | { kind: 'missing'; reason: string }> {
      this.keyringPromise ??= loadKeyring();
      return this.keyringPromise;
    }

    async read(serverName: string): Promise<StoredOAuthRecord | null> {
      const kr = await this.keyring();
      if ('kind' in kr) {
        throw new Error(`Keychain unavailable: ${kr.reason}`);
      }
      const entry = new kr.Entry(SERVICE_NAME, accountFor(serverName));
      const raw = entry.getPassword();
      if (raw === null) return null;
      return JSON.parse(raw) as StoredOAuthRecord;
    }

    async write(serverName: string, record: StoredOAuthRecord): Promise<void> {
      const kr = await this.keyring();
      if ('kind' in kr) {
        throw new Error(`Keychain unavailable: ${kr.reason}`);
      }
      const entry = new kr.Entry(SERVICE_NAME, accountFor(serverName));
      entry.setPassword(JSON.stringify(record));
    }

    async delete(serverName: string): Promise<void> {
      const kr = await this.keyring();
      if ('kind' in kr) {
        // Fail loud, matching read/write. A silent no-op here would let
        // `tlbx auth logout` and `tlbx doctor --fix` report success when
        // the credential was never actually deleted — that's worse than
        // a clear error message naming the keychain failure mode.
        throw new Error(`Keychain unavailable: ${kr.reason}`);
      }
      const entry = new kr.Entry(SERVICE_NAME, accountFor(serverName));
      entry.deletePassword();
    }

    async list(): Promise<string[]> {
      const kr = await this.keyring();
      if ('kind' in kr) {
        // Fail loud, matching read/write/delete. Returning [] would mask a
        // storage failure as "no stored tokens", which breaks `tlbx doctor`
        // drift detection and `tlbx auth status` enumeration.
        throw new Error(`Keychain unavailable: ${kr.reason}`);
      }
      // findCredentials is platform-dependent; some backends omit it.
      const fn = new kr.Entry(SERVICE_NAME, accountFor('_probe_')).findCredentials;
      if (typeof fn !== 'function') {
        this.deps.logger.warn(
          'KeychainTokenStore: findCredentials not supported on this platform; list() returns []',
        );
        return [];
      }
      const creds = fn();
      return creds
        .map((c) => c.account)
        .filter((a) => a.startsWith(ACCOUNT_PREFIX))
        .map((a) => a.slice(ACCOUNT_PREFIX.length));
    }

    async probe(): Promise<TokenStoreHealth> {
      const kr = await this.keyring();
      if ('kind' in kr) {
        return { kind: 'unavailable', reason: kr.reason };
      }
      // Functional probe: write+delete a sentinel.
      try {
        const sentinel = `_probe_${process.pid}_${Date.now()}`;
        const entry = new kr.Entry(SERVICE_NAME, accountFor(sentinel));
        entry.setPassword('probe');
        entry.deletePassword();
        return { kind: 'ready' };
      } catch (err) {
        return {
          kind: 'unavailable',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  ```

- **`packages/core/src/auth/token-store-factory.ts`** — replace the F1-13 throw with a real instantiation:

  ```ts
  case 'keychain':
    return new KeychainTokenStore({ logger: deps.logger });
  ```

- **`packages/core/src/auth/__tests__/keychain-token-store.test.ts`** — tests that mock the dynamic import:
  - Use Vitest's module mocker: `vi.mock('@napi-rs/keyring', () => ({ Entry: MockEntry }))` where `MockEntry` is an in-memory class that mirrors the real API surface.
  - Round-trip: `write('github', record)` then `read('github')` returns the same record.
  - Account naming: assert `setPassword` was called against `service='dev.toolbox.cli'`, `account='oauth:github'`.
  - `read` of an unknown server returns `null`.
  - `delete` of a non-existent server is a no-op when the keychain is available (no throw — the underlying `deletePassword()` returns false but we don't surface it).
  - `delete` when the keychain is **unavailable** throws `Keychain unavailable: <reason>` (matching `read` and `write`). Verified via the same `vi.doMock` setup that exercises the unavailable-on-import path.
  - `list` returns only accounts with the `oauth:` prefix and strips it (when the keychain is available).
  - `list` when the keychain is **unavailable** throws `Keychain unavailable: <reason>` (matching `read`/`write`/`delete`).
  - `probe` returns `ready` for a working mock; returns `unavailable` with the reason string when `setPassword` throws.
  - `unavailable` path: separate test where `vi.mock` throws on import (`vi.doMock('@napi-rs/keyring', () => { throw new Error('libsecret not found'); })`). Assert `probe()` returns `{ kind: 'unavailable', reason: 'libsecret not found' }` and `read()` throws `Keychain unavailable: libsecret not found`.

- **`packages/core/src/auth/__tests__/token-store-factory.test.ts`** — update the F1-13 test:
  - `createTokenStore({ type: 'keychain' }, ...)` now returns a `KeychainTokenStore` instance (don't `instanceof` — assert via `probe()` shape, since `KeychainTokenStore` isn't exported through the barrel).

- **README or CHANGELOG note (optional)**: a one-liner under the "Auth" section saying ToolBox uses the OS keychain for OAuth credentials and how to diagnose unavailability (`tlbx doctor` — which F1-22 wires up).

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- `pnpm install` on a clean machine without libsecret succeeds (optional dep should not fail install). Verify manually if CI doesn't already test this; otherwise add a note that this needs to be checked once before merge.
- Mocked-keyring tests cover: round-trip, account naming, read-missing-null, delete-missing-noop, list-filtering, probe-success, probe-failure-with-reason, unavailable-on-import.
- Logs emitted by `KeychainTokenStore` never contain token bytes (audit via review; F1-23 adds a CI grep gate).

## Out of scope

- Real-keychain integration tests on macOS / Windows / Linux CI matrix — left as a pre-release manual smoke test.
- Multi-account support (`oauth:<server>:<identity>`) — additive future work.
- Token redaction in the central logger module — F1-23 adds the CI grep gate.

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
