import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

import type { Logger } from '../logging/logger.js';
import { SuppressedRedirectError, ToolBoxOAuthProvider } from './oauth-provider.js';
import type { TokenStore } from './token-store.js';

export interface RunOAuthRefreshInput {
  serverName: string;
  serverUrl: URL;
  /** Resource-metadata URL from the probe (§4.6.2), if available. */
  resourceMetadataUrl?: URL;
  tokenStore: TokenStore;
  logger: Logger;
}

export type RunOAuthRefreshResult = { kind: 'success' } | { kind: 'failed'; reason: string };

/**
 * The redirect URL the provider reports for DCR metadata. Refresh never opens a
 * browser: on the happy path the SDK exchanges the stored `refresh_token`
 * without redirecting, and a refresh that fails irrecoverably surfaces as a
 * thrown `SuppressedRedirectError` (which we translate to a `failed` result)
 * rather than a real browser launch. A fixed loopback placeholder is therefore
 * sufficient — no callback server is bound for a refresh.
 */
const REFRESH_REDIRECT_PLACEHOLDER = new URL('http://127.0.0.1/callback');

/**
 * Non-interactive token refresh used by `tlbx auth refresh <server>`. Drives the
 * SDK `auth()` helper with no authorization code, so it reads the stored tokens
 * and exchanges the `refresh_token` grant directly (§4.6.2). The provider's
 * `saveTokens` is the single commit point — a failed refresh re-throws before it
 * runs, leaving the previously stored record intact.
 */
export async function runOAuthRefresh(input: RunOAuthRefreshInput): Promise<RunOAuthRefreshResult> {
  const provider = new ToolBoxOAuthProvider({
    serverName: input.serverName,
    redirectUrl: REFRESH_REDIRECT_PLACEHOLDER,
    tokenStore: input.tokenStore,
    logger: input.logger,
  });

  try {
    await auth(provider, {
      serverUrl: input.serverUrl.toString(),
      ...(input.resourceMetadataUrl ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
    });
    return { kind: 'success' };
  } catch (err) {
    if (err instanceof SuppressedRedirectError) {
      // The refresh did not yield usable tokens, so the SDK fell through to a
      // fresh authorization request. That needs the browser — out of scope for
      // a non-interactive refresh — so report it as a failure pointing the user
      // at `tlbx auth login`.
      return {
        kind: 'failed',
        reason:
          'stored credentials can no longer be refreshed; run `tlbx auth login` to re-authenticate',
      };
    }
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
