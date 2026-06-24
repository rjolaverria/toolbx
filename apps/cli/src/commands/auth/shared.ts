import {
  createNoopLogger,
  createTokenStore,
  probeUpstreamAuth,
  runOAuthLogin,
  runOAuthRefresh,
  type AuthHint,
  type Logger,
  type RunOAuthLoginInput,
  type RunOAuthLoginResult,
  type HttpServerConfig,
  type RunOAuthRefreshInput,
  type RunOAuthRefreshResult,
  type ServerConfig,
  type TokenStorage,
  type TokenStore,
  type WithConfigLockOptions,
} from '@rjolaverria/toolbox-core';

import { defaultServerCommandDeps, type ServerCommandDeps } from '../server-shared.js';

export interface AuthCommandDeps extends ServerCommandDeps {
  logger: Logger;
  /** Resolves the configured token-store backend. Tests inject an in-memory store. */
  createTokenStore: (storage: TokenStorage) => TokenStore;
  /**
   * Best-effort probe of the upstream endpoint, used to recover the RFC 9728
   * `resource_metadata` URL for servers whose authorization server is only
   * discoverable from the `WWW-Authenticate` challenge.
   */
  probeAuth: (url: URL) => Promise<AuthHint>;
  runOAuthLogin: (input: RunOAuthLoginInput) => Promise<RunOAuthLoginResult>;
  runOAuthRefresh: (input: RunOAuthRefreshInput) => Promise<RunOAuthRefreshResult>;
  /**
   * Credential-lock acquire options. Production leaves this undefined so each
   * command uses its own default timeout; tests inject a short timeout to
   * exercise the busy-contention path quickly.
   */
  lockOptions?: WithConfigLockOptions;
}

export function defaultAuthCommandDeps(): AuthCommandDeps {
  const logger = createNoopLogger();
  return {
    ...defaultServerCommandDeps(),
    logger,
    createTokenStore: (storage) => createTokenStore(storage, { logger }),
    probeAuth: (url) => probeUpstreamAuth(url, { logger }),
    runOAuthLogin,
    runOAuthRefresh,
  };
}

/**
 * Acquire timeout for the credential lock around `auth login`. Like `add-http`,
 * login holds the lock across the browser handshake (up to the 5-minute callback
 * default), so a competing same-name credential command must wait at least that
 * long rather than failing spuriously. Generous margin over the callback default.
 */
export const CREDENTIAL_LOGIN_LOCK_TIMEOUT_MS = 6 * 60_000;

/**
 * Acquire timeout for the credential lock around the non-interactive credential
 * commands (`auth logout | refresh`, `doctor --fix`). These never open a browser,
 * but `auth refresh` does hold the lock across a token-endpoint round-trip, so
 * the timeout is sized to comfortably outlast a normal non-interactive refresh
 * (discovery + refresh ≈ sub-second to a few seconds) — letting a concurrent
 * `logout`/`doctor` wait it out and then proceed — while staying far below the
 * multi-minute hold of an interactive login/`add-http`, against which these
 * commands still fail fast with a clear "in progress" message rather than
 * blocking the terminal. (`withConfigLock`'s own default is longer still.)
 */
export const CREDENTIAL_CONTENTION_LOCK_TIMEOUT_MS = 5_000;

/** Stderr message when a credential lock cannot be acquired because a same-name
 * login is in progress. */
export function credentialBusyMessage(name: string): string {
  return `Another credential operation for ${name} is in progress; try again once it finishes.\n`;
}

/**
 * Best-effort lookup of the RFC 9728 `resource_metadata` URL for an OAuth
 * server. Returns `undefined` when the probe cannot reach the endpoint or the
 * server does not advertise one, in which case the SDK falls back to
 * origin-based discovery.
 */
export async function discoverResourceMetadataUrl(
  deps: AuthCommandDeps,
  serverUrl: URL,
): Promise<URL | undefined> {
  const hint = await deps.probeAuth(serverUrl);
  return hint.kind === 'oauth' ? hint.resourceMetadataUrl : undefined;
}

/** The `auth.type` a server is configured with, normalized for messaging. */
export function authTypeOf(entry: ServerConfig): string {
  if (entry.type === 'http' && entry.auth !== undefined) {
    return entry.auth.type;
  }
  return 'none';
}

export type OAuthServerConfig = HttpServerConfig & { auth: { type: 'oauth' } };

/** True only for HTTP servers explicitly configured with `auth.type === 'oauth'`. */
export function isOAuthServer(entry: ServerConfig): entry is OAuthServerConfig {
  return entry.type === 'http' && entry.auth?.type === 'oauth';
}
