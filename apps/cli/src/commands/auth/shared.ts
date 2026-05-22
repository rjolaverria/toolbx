import {
  createNoopLogger,
  createTokenStore,
  runOAuthLogin,
  runOAuthRefresh,
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
  runOAuthLogin: (input: RunOAuthLoginInput) => Promise<RunOAuthLoginResult>;
  runOAuthRefresh: (input: RunOAuthRefreshInput) => Promise<RunOAuthRefreshResult>;
}

export function defaultAuthCommandDeps(): AuthCommandDeps {
  const logger = createNoopLogger();
  return {
    ...defaultServerCommandDeps(),
    logger,
    createTokenStore: (storage) => createTokenStore(storage, { logger }),
    runOAuthLogin,
    runOAuthRefresh,
  };
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
