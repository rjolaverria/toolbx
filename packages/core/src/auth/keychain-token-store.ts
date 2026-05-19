import type { Logger } from '../logging/logger.js';
import type { StoredOAuthRecord, TokenStore, TokenStoreHealth } from './token-store.js';

const SERVICE_NAME = 'dev.toolbox.cli';
const ACCOUNT_PREFIX = 'oauth:';
const KEYRING_PACKAGE = '@napi-rs/keyring';

function accountFor(serverName: string): string {
  return `${ACCOUNT_PREFIX}${serverName}`;
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

function errorReason(err: unknown): string {
  if (err instanceof Error) {
    if (err.cause instanceof Error) {
      return err.cause.message;
    }
    return err.message;
  }
  return String(err);
}

async function loadKeyring(): Promise<KeyringModule | MissingKeyring> {
  try {
    const mod = (await import(KEYRING_PACKAGE)) as KeyringModule;
    return mod;
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
}

export class KeychainTokenStore implements TokenStore {
  private keyringPromise: Promise<KeyringModule | MissingKeyring> | null = null;

  constructor(private readonly deps: KeychainTokenStoreDeps) {}

  private async keyring(): Promise<KeyringModule | MissingKeyring> {
    this.keyringPromise ??= loadKeyring();
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
    return JSON.parse(raw) as StoredOAuthRecord;
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

    try {
      const sentinel = `_probe_${process.pid}_${Date.now()}`;
      const entry = new kr.Entry(SERVICE_NAME, accountFor(sentinel));
      entry.setPassword('probe');
      entry.deletePassword();
      return { kind: 'ready' };
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: errorReason(err),
      };
    }
  }
}
