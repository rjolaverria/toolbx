import type { OAuthClientInformation, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

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

/**
 * Test-only in-memory backend. The factory in `./token-store-factory.ts` never
 * instantiates this — production code paths always go through a real backend
 * (e.g. `KeychainTokenStore` from F1-14). Tests import this class directly.
 */
export class InMemoryTokenStore implements TokenStore {
  private readonly entries = new Map<string, StoredOAuthRecord>();

  read(serverName: string): Promise<StoredOAuthRecord | null> {
    return Promise.resolve(this.entries.get(serverName) ?? null);
  }

  write(serverName: string, record: StoredOAuthRecord): Promise<void> {
    this.entries.set(serverName, record);
    return Promise.resolve();
  }

  delete(serverName: string): Promise<void> {
    this.entries.delete(serverName);
    return Promise.resolve();
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.entries.keys()]);
  }

  probe(): Promise<TokenStoreHealth> {
    return Promise.resolve({ kind: 'ready' });
  }
}
