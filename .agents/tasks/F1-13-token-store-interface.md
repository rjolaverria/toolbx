# F1-13 — TokenStore interface, factory, and InMemoryTokenStore

**Milestone**: Phase 1 follow-up (OAuth upstream auth, foundation)
**SPECS references**: §4.6.2 (Upstream OAuth 2.1 auth — token storage decisions)
**Depends on**: F1-12

## Goal

Establish the only API any other code touches for OAuth tokens — a small `TokenStore` interface with one in-memory implementation and a config-driven factory. Future backends (file, encrypted-file) drop in without changing call sites.

## Motivation

SPECS §4.6.2 commits to a pluggable storage abstraction: the interface is the contract; backends are interchangeable. Defining the interface, the in-memory implementation, and the factory up-front means F1-14 (keychain) can be developed and tested in isolation, and every later task that needs tokens — F1-17, F1-18, F1-19, F1-21, F1-22 — has a stable target to import.

## Deliverables

- **`packages/core/src/auth/token-store.ts`** — new file. Public surface:

  ```ts
  import type {
    OAuthClientInformation,
    OAuthTokens,
  } from '@modelcontextprotocol/sdk/shared/auth.js';

  export interface StoredOAuthRecord {
    /** Bump when the on-disk shape changes. Currently 1. */
    schemaVersion: 1;
    clientInformation: OAuthClientInformation;
    tokens: OAuthTokens;
    /** Authorization server URL or issuer identifier from discovery. */
    authorizationServer: string;
    scopes: string[];
    /** ISO timestamp; obtained-at, not expires-at. */
    obtainedAt: string;
  }

  export type TokenStoreHealth = { kind: 'ready' } | { kind: 'unavailable'; reason: string };

  export interface TokenStore {
    read(serverName: string): Promise<StoredOAuthRecord | null>;
    write(serverName: string, record: StoredOAuthRecord): Promise<void>;
    delete(serverName: string): Promise<void>;
    list(): Promise<string[]>;
    probe(): Promise<TokenStoreHealth>;
  }

  /** Test-only in-memory backend. Never instantiated by the factory. */
  export class InMemoryTokenStore implements TokenStore {
    private readonly entries = new Map<string, StoredOAuthRecord>();
    async read(serverName: string): Promise<StoredOAuthRecord | null> {
      return this.entries.get(serverName) ?? null;
    }
    async write(serverName: string, record: StoredOAuthRecord): Promise<void> {
      this.entries.set(serverName, record);
    }
    async delete(serverName: string): Promise<void> {
      this.entries.delete(serverName);
    }
    async list(): Promise<string[]> {
      return [...this.entries.keys()];
    }
    async probe(): Promise<TokenStoreHealth> {
      return { kind: 'ready' };
    }
  }
  ```

  Note: `OAuthClientInformation` and `OAuthTokens` are re-exported from the MCP SDK (`@modelcontextprotocol/sdk/shared/auth.js`). Confirm the import path against the installed SDK version (`1.29.0`) before committing.

- **`packages/core/src/auth/token-store-factory.ts`** — new file:

  ```ts
  import type { Logger } from '../logging/logger.js';
  import type { TokenStorageConfig } from '../config/schema.js';
  import type { TokenStore } from './token-store.js';

  export interface CreateTokenStoreDeps {
    logger: Logger;
  }

  export function createTokenStore(
    storage: TokenStorageConfig,
    deps: CreateTokenStoreDeps,
  ): TokenStore {
    switch (storage.type) {
      case 'keychain':
        // F1-14 will replace this throw with a real instantiation.
        throw new Error(
          'KeychainTokenStore not yet implemented (F1-14). ' +
            'Use InMemoryTokenStore in tests until then.',
        );
      default: {
        // Exhaustiveness check — TypeScript will flag missing cases. Assert
        // against `storage` itself, not `storage.type`: after the switch
        // narrows, `storage` is `never`, so accessing `.type` here would
        // also fail to compile. JSON-stringify the value separately for the
        // runtime error message (which is reached only if the runtime input
        // bypasses the Zod schema — defensive).
        const exhaustive: never = storage;
        throw new Error(`Unknown token storage type: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  ```

  The factory is the **only** place in the codebase that switches on `storage.type`. Every consumer receives an opaque `TokenStore`.

- **`packages/core/src/auth/__tests__/token-store.test.ts`** — tests for `InMemoryTokenStore`:
  - Empty `read` returns `null`.
  - Round-trip: `write` then `read` returns the same record.
  - `write` then `write` overwrites (no append).
  - `delete` removes; subsequent `read` returns `null`.
  - `list` reflects the current keyset; stable ordering not required.
  - `probe` returns `ready`.

- **`packages/core/src/auth/__tests__/token-store-factory.test.ts`** — tests for `createTokenStore`:
  - `keychain` throws the "not yet implemented" error with the F1-14 reference. (F1-14 will update this test to assert it returns a `KeychainTokenStore`.)
  - Exhaustiveness check survives `pnpm typecheck` — captured by a compile-time test if the project uses `tsd` / `expect-type`; otherwise document the check in a comment in the test file.

- **`packages/core/src/auth/index.ts`** — new barrel export for the auth namespace, exporting only:
  - `TokenStore`, `StoredOAuthRecord`, `TokenStoreHealth` types
  - `InMemoryTokenStore` (test usage only — flag with JSDoc)
  - `createTokenStore`, `CreateTokenStoreDeps`

  Do **not** export `KeychainTokenStore` from here — F1-14 will export its own factory; the rest of the codebase only sees the interface.

- **`packages/core/src/index.ts`** — re-export from `./auth/index.js` so consumers can `import { TokenStore } from '@toolbox/core'`.

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- A consumer can write:
  ```ts
  import { createTokenStore } from '@toolbox/core';
  const store = createTokenStore(config.auth?.storage ?? { type: 'keychain' }, { logger });
  ```
  and get a TypeScript-typed `TokenStore` (which will throw at runtime until F1-14 lands — that's expected and documented in the error message).
- `InMemoryTokenStore` round-trip behavior is covered by tests.
- No other file in the codebase switches on `storage.type` after this task (check by `grep -rn "storage.type"` — only `token-store-factory.ts` should appear).

## Out of scope

- KeychainTokenStore implementation (F1-14).
- Any reference to `@napi-rs/keyring` (F1-14 adds the dependency).
- Encryption, file backends, schema-migration helpers.
- Tests that use the factory to _instantiate_ a real backend — those land with F1-14.

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
