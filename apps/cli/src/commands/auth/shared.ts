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
} from '@toolbox/core';

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
