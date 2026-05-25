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

/** Current on-disk record shape. Bump when the persisted fields change. */
export const CURRENT_OAUTH_SCHEMA_VERSION = 2;

export const StoredOAuthRecordSchema = z
  .object({
    /** Bump when the on-disk shape changes. v1 predates `resource` (F1-13..F1-19). */
    schemaVersion: z.literal(CURRENT_OAUTH_SCHEMA_VERSION),
    clientInformation: OAuthClientInformationMixedSchema,
    tokens: OAuthTokensSchema,
    /** Authorization server URL or issuer identifier from discovery. */
    authorizationServer: z.string().min(1),
    scopes: z.array(z.string()),
    /**
     * RFC 8707 resource indicator the SDK selected at login (from RFC 9728
     * protected-resource metadata). Absent means login used no resource
     * indicator; refresh must then send none either. Replayed on refresh so a
     * resource-bound authorization server issues a token for the right audience.
     */
    resource: z.url().optional(),
    /** ISO timestamp; obtained-at, not expires-at. */
    obtainedAt: z.iso.datetime(),
  })
  .strict();

export type StoredOAuthRecord = z.infer<typeof StoredOAuthRecordSchema>;

/**
 * Upgrades a parsed-but-unvalidated stored record from an older on-disk schema
 * version to the current one, so records written before a field was added keep
 * loading. v1 records (F1-13..F1-19) predate the optional `resource` indicator;
 * its absence is meaningful ("login used no RFC 8707 resource"), so the upgrade
 * only rewrites the version stamp and leaves `resource` unset. Anything that is
 * not a recognized older record passes through untouched for schema validation
 * to reject.
 */
export function migrateStoredOAuthRecord(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1
  ) {
    return { ...(value as Record<string, unknown>), schemaVersion: CURRENT_OAUTH_SCHEMA_VERSION };
  }
  return value;
}

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
