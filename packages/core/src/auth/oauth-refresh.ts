import {
  discoverAuthorizationServerMetadata,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';

import type { Logger } from '../logging/logger.js';
import type { StoredOAuthRecord, TokenStore } from './token-store.js';

export interface RunOAuthRefreshInput {
  serverName: string;
  tokenStore: TokenStore;
  logger: Logger;
  /** Test seam for the token-endpoint network call. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
}

export type RunOAuthRefreshResult = { kind: 'success' } | { kind: 'failed'; reason: string };

/**
 * Non-interactive token refresh used by `tlbx auth refresh <server>`.
 *
 * Refreshes against the authorization server persisted in the stored record at
 * login time — never re-derived from the MCP server URL. The stored issuer is
 * authoritative and stays reachable even when the resource server's metadata is
 * not, and going straight to it surfaces the real token-endpoint error instead
 * of collapsing into a browser-redirect path. Tokens are written only after the
 * SDK refresh helper succeeds, so a failed refresh leaves the record intact.
 */
export async function runOAuthRefresh(input: RunOAuthRefreshInput): Promise<RunOAuthRefreshResult> {
  const log = input.logger.child({ component: 'oauth-refresh', server: input.serverName });

  const fetchOpt = input.fetchFn ? { fetchFn: input.fetchFn } : {};
  try {
    // Read inside the handled section: a keychain/backend that throws on an
    // unavailable or corrupt record must yield a `failed` result, not reject —
    // direct callers (e.g. future gateway lazy refresh) rely on that contract.
    const record = await input.tokenStore.read(input.serverName);
    if (record === null) {
      return { kind: 'failed', reason: `no stored credentials for ${input.serverName}` };
    }
    const refreshToken = record.tokens.refresh_token;
    if (refreshToken === undefined) {
      return {
        kind: 'failed',
        reason: `stored token for ${input.serverName} has no refresh_token; run \`tlbx auth login\``,
      };
    }

    const metadata = await discoverAuthorizationServerMetadata(
      record.authorizationServer,
      fetchOpt,
    );
    const tokens = await refreshAuthorization(record.authorizationServer, {
      ...(metadata ? { metadata } : {}),
      clientInformation: record.clientInformation,
      refreshToken,
      ...fetchOpt,
    });
    // `refreshAuthorization` preserves the prior refresh_token when the server
    // does not rotate one, so `tokens` always carries a usable refresh token.
    const next: StoredOAuthRecord = {
      ...record,
      tokens,
      obtainedAt: new Date().toISOString(),
    };
    await input.tokenStore.write(input.serverName, next);
    return { kind: 'success' };
  } catch (err) {
    log.debug({ err }, 'token refresh failed');
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
