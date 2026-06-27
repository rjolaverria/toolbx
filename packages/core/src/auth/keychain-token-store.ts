import type { Logger } from '../logging/logger.js';
import {
  StoredOAuthRecordSchema,
  migrateStoredOAuthRecord,
  type StoredOAuthRecord,
  type TokenStore,
  type TokenStoreHealth,
} from './token-store.js';

/**
 * Keychain service name. The OS keychain is machine-global (per OS user) and
 * indexes every Toolbx credential under this one fixed service, so a stored
 * record's identity is `(SERVICE_NAME, oauth:<serverName>)` — independent of
 * which `config.json` was used to reach it. The credential lock that serializes
 * mutations of that record must share the same machine-global domain; see
 * {@link resolveCredentialLockRoot}.
 */
export const KEYCHAIN_SERVICE_NAME = 'dev.toolbx.cli';
const SERVICE_NAME = KEYCHAIN_SERVICE_NAME;
const ACCOUNT_PREFIX = 'oauth:';
const PROBE_ACCOUNT_PREFIX = 'probe:';
const KEYRING_PACKAGE = '@napi-rs/keyring';

function accountFor(serverName: string): string {
  return `${ACCOUNT_PREFIX}${serverName}`;
}

function probeAccountFor(sentinel: string): string {
  return `${PROBE_ACCOUNT_PREFIX}${sentinel}`;
}

/**
 * Dynamically imported keyring API surface, hand-typed so this module compiles
 * even when the optional native dependency is unavailable at runtime.
 */
type KeyringEntryCtor = new (
  service: string,
  account: string,
) => {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
};

type KeyringModule = {
  Entry: KeyringEntryCtor;
  findCredentials?: (
    service: string,
    target?: string | null,
  ) => Array<{ account: string; password: string }>;
};

type MissingKeyring = { kind: 'missing'; reason: string };
type LoadKeyring = () => Promise<KeyringModule>;

function errorReason(err: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message.length > 0) {
      messages.push(current.message);
    }
    current = current.cause;
  }
  if (messages.length > 0) {
    if (current !== undefined && current !== null && !seen.has(current)) {
      if (typeof current === 'string') {
        messages.push(current);
      } else if (
        typeof current === 'number' ||
        typeof current === 'boolean' ||
        typeof current === 'bigint' ||
        typeof current === 'symbol'
      ) {
        messages.push(current.toString());
      } else {
        messages.push('non-Error cause');
      }
    }
    return messages.join(': ');
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function corruptEntryError(serverName: string, reason: string): Error {
  return new Error(`Keychain entry for ${serverName} is corrupt: ${reason}`);
}

function parseStoredRecord(serverName: string, raw: string): StoredOAuthRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptEntryError(serverName, 'invalid JSON');
  }

  const result = StoredOAuthRecordSchema.safeParse(migrateStoredOAuthRecord(parsed));
  if (!result.success) {
    throw corruptEntryError(serverName, 'stored record does not match schema');
  }
  return result.data;
}

async function importKeyring(): Promise<KeyringModule> {
  const mod = (await import(KEYRING_PACKAGE)) as KeyringModule;
  return mod;
}

async function loadKeyring(
  loader: LoadKeyring = importKeyring,
): Promise<KeyringModule | MissingKeyring> {
  try {
    return await loader();
  } catch (err) {
    return {
      kind: 'missing',
      reason: errorReason(err),
    };
  }
}

function unavailableError(reason: string): Error {
  return new Error(`Keychain unavailable: ${reason}`);
}

export interface KeychainTokenStoreDeps {
  logger: Logger;
  /** Test seam; production uses the dynamic import loader. */
  loadKeyring?: LoadKeyring;
}

export class KeychainTokenStore implements TokenStore {
  private keyringPromise: Promise<KeyringModule | MissingKeyring> | null = null;

  constructor(private readonly deps: KeychainTokenStoreDeps) {}

  private async keyring(): Promise<KeyringModule | MissingKeyring> {
    this.keyringPromise ??= loadKeyring(this.deps.loadKeyring);
    return this.keyringPromise;
  }

  async read(serverName: string): Promise<StoredOAuthRecord | null> {
    const kr = await this.keyring();
    if ('kind' in kr) {
      throw unavailableError(kr.reason);
    }

    const entry = new kr.Entry(SERVICE_NAME, accountFor(serverName));
    const raw = entry.getPassword();
    if (raw === null) {
      return null;
    }
    return parseStoredRecord(serverName, raw);
  }

  async write(serverName: string, record: StoredOAuthRecord): Promise<void> {
    const kr = await this.keyring();
    if ('kind' in kr) {
      throw unavailableError(kr.reason);
    }

    const entry = new kr.Entry(SERVICE_NAME, accountFor(serverName));
    entry.setPassword(JSON.stringify(record));
  }

  async delete(serverName: string): Promise<void> {
    const kr = await this.keyring();
    if ('kind' in kr) {
      throw unavailableError(kr.reason);
    }

    const entry = new kr.Entry(SERVICE_NAME, accountFor(serverName));
    entry.deletePassword();
  }

  async list(): Promise<string[]> {
    const kr = await this.keyring();
    if ('kind' in kr) {
      throw unavailableError(kr.reason);
    }

    if (typeof kr.findCredentials !== 'function') {
      this.deps.logger.warn(
        'KeychainTokenStore: findCredentials not supported on this platform; list() returns []',
      );
      return [];
    }

    return kr
      .findCredentials(SERVICE_NAME)
      .map((credential) => credential.account)
      .filter((account) => account.startsWith(ACCOUNT_PREFIX))
      .map((account) => account.slice(ACCOUNT_PREFIX.length));
  }

  async probe(): Promise<TokenStoreHealth> {
    const kr = await this.keyring();
    if ('kind' in kr) {
      return { kind: 'unavailable', reason: kr.reason };
    }

    const sentinel = `_probe_${process.pid}_${Date.now()}`;
    const entry = new kr.Entry(SERVICE_NAME, probeAccountFor(sentinel));
    try {
      entry.setPassword('probe');
      entry.deletePassword();
      return { kind: 'ready' };
    } catch (err) {
      try {
        entry.deletePassword();
      } catch {
        // Best-effort cleanup only; the returned health reason is from the
        // operation that proved the keychain is not fully usable.
      }
      return {
        kind: 'unavailable',
        reason: errorReason(err),
      };
    }
  }
}
