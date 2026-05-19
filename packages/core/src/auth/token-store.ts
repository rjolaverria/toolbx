import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

const OAuthClientInformationMixedSchema = z.union([
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
]);

export const StoredOAuthRecordSchema = z
  .object({
    /** Bump when the on-disk shape changes. Currently 1. */
    schemaVersion: z.literal(1),
    clientInformation: OAuthClientInformationMixedSchema,
    tokens: OAuthTokensSchema,
    /** Authorization server URL or issuer identifier from discovery. */
    authorizationServer: z.string().min(1),
    scopes: z.array(z.string()),
    /** ISO timestamp; obtained-at, not expires-at. */
    obtainedAt: z.iso.datetime(),
  })
  .strict();

export type StoredOAuthRecord = z.infer<typeof StoredOAuthRecordSchema>;

export type TokenStoreHealth = { kind: 'ready' } | { kind: 'unavailable'; reason: string };

export interface TokenStore {
  read(serverName: string): Promise<StoredOAuthRecord | null>;
  write(serverName: string, record: StoredOAuthRecord): Promise<void>;
  delete(serverName: string): Promise<void>;
  /**
   * Lists server names with stored records. Some keychain backends cannot
   * enumerate credentials, so an empty result may mean either "no records" or
   * "enumeration unsupported"; call sites that need to diagnose storage health
   * should also use `probe()`.
   */
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
