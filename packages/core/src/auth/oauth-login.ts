import { auth, discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';

import type { Logger } from '../logging/logger.js';
import { startCallbackServer, type CallbackServer } from './oauth-callback-server.js';
import { SuppressedRedirectError, ToolBoxOAuthProvider } from './oauth-provider.js';
import type { TokenStore } from './token-store.js';

export interface RunOAuthLoginInput {
  serverName: string;
  serverUrl: URL;
  /** Resource-metadata URL from the probe (§4.6.2), if available. */
  resourceMetadataUrl?: URL;
  /** Scopes to request during DCR; usually omitted (server-default). */
  scopes?: string[];
  tokenStore: TokenStore;
  logger: Logger;
  /**
   * Open the authorization URL in the user's browser.
   * Default: dynamically imports `open` (runtime dep). Tests inject a stub
   * that synthesizes a redirect to the callback server.
   */
  openBrowser?: (url: URL) => Promise<void>;
  /** Override the callback server's wait timeout. */
  callbackTimeoutMs?: number;
  /** Listen for cancellation (Ctrl-C / parent abort). */
  abortSignal?: AbortSignal;
  /**
   * Force the full browser handshake even if a usable token is already in the
   * TokenStore. Set to true by `tlbx auth login <server>` so the user can
   * switch identities (§4.2 / §4.6.2 explicitly support this). Default false —
   * `tlbx server add-http` keeps the early-success shortcut, since by
   * definition there is no pre-existing token for a brand-new server.
   */
  forceReauth?: boolean;
}

export type RunOAuthLoginResult =
  | { kind: 'success' }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'failed'; reason: string };

/**
 * Composes every OAuth primitive — callback server, discovery, provider, and
 * the SDK `auth()` driver — into the full browser-authentication flow used by
 * both `tlbx auth login` and the auto-trigger inside `server add-http`.
 *
 * Atomicity (§4.6.2): tokens are written by the provider's `saveTokens` only
 * after the code exchange completes. Every early-return branch leaves the
 * TokenStore record at `serverName` either absent (no prior token) or
 * unchanged (a prior token a failed refresh did not touch).
 */
export async function runOAuthLogin(input: RunOAuthLoginInput): Promise<RunOAuthLoginResult> {
  const log = input.logger.child({ component: 'oauth-login', server: input.serverName });
  const openBrowser = input.openBrowser ?? defaultOpenBrowser;

  let callback: CallbackServer | null = null;
  try {
    callback = await startCallbackServer({
      logger: input.logger,
      ...(input.callbackTimeoutMs !== undefined ? { timeoutMs: input.callbackTimeoutMs } : {}),
    });

    // Resolve the authorization-server URL up-front via the SDK's discovery
    // helper. We use the discovered value (NOT authorizationUrl.origin) as the
    // authoritative authorization_server identifier for the persisted
    // StoredOAuthRecord: authorizationUrl.origin would drop issuer-path
    // information (e.g. `https://issuer.example/auth/`) for OAuth servers whose
    // metadata is not rooted at the bare origin, and later refreshes would
    // target the wrong endpoint.
    const serverInfo = await discoverOAuthServerInfo(input.serverUrl.toString(), {
      ...(input.resourceMetadataUrl ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
    });
    if (!serverInfo.authorizationServerUrl) {
      return {
        kind: 'failed',
        reason: 'OAuth server discovery did not return an authorization_server URL',
      };
    }

    const provider = new ToolBoxOAuthProvider({
      serverName: input.serverName,
      redirectUrl: callback.redirectUri,
      ...(input.scopes ? { scopes: input.scopes } : {}),
      tokenStore: input.tokenStore,
      logger: input.logger,
      authorizationServer: serverInfo.authorizationServerUrl,
    });

    if (input.forceReauth) {
      // Identity-switch path: tell the provider to act as if no tokens are
      // stored so the SDK proceeds through DCR + authorize instead of
      // short-circuiting on a still-valid token. Stored tokens stay on disk
      // until `saveTokens` writes the new ones (atomicity preserved).
      provider.suppressStoredTokensForReauth();
    }

    // First half: discovery + (optional) DCR + build authorization URL. The SDK
    // calls provider.redirectToAuthorization, which throws SuppressedRedirectError
    // so we can intercept the URL and open the browser ourselves at the moment
    // of our choosing.
    let authorizationUrl: URL;
    try {
      await auth(provider, {
        serverUrl: input.serverUrl.toString(),
        ...(input.resourceMetadataUrl ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
      });
      // If `auth()` returned without throwing, the SDK believed we already had
      // a usable token (or refreshed one). With forceReauth=false that's a
      // legitimate shortcut. With forceReauth=true the suppression above makes
      // this branch unreachable; the SDK always proceeds to redirect.
      return { kind: 'success' };
    } catch (err) {
      if (err instanceof SuppressedRedirectError) {
        authorizationUrl = err.authorizationUrl;
      } else {
        throw err;
      }
    }

    // Second half: arm the callback server BEFORE opening the browser, because
    // a fast redirect could otherwise arrive while expectedState is still unset
    // and be rejected as a state mismatch.
    const state = authorizationUrl.searchParams.get('state');
    if (!state) {
      return { kind: 'failed', reason: 'authorization URL missing state parameter' };
    }
    const codePromise = callback.waitForCode(state);
    // Attach a no-op rejection handler immediately. If cancellation wins before
    // we await `codePromise` (e.g. abort during openBrowser), the `finally`
    // block calls `callback.close()` which rejects this promise — without this
    // handler that's an unhandled rejection. Legitimate rejections are still
    // surfaced via the `await` in the success path below.
    void codePromise.catch(() => undefined);

    const abortPromise: Promise<'aborted'> = input.abortSignal
      ? abortToPromise(input.abortSignal)
      : new Promise(() => undefined);

    // Race the browser-open AGAINST the abort signal too — a slow or hung
    // `open` (e.g. when no default browser is registered) must not block
    // cancellation.
    log.info({ url: authorizationUrl.toString() }, 'opening browser for authorization');
    const browserOrAbort = await Promise.race([
      openBrowser(authorizationUrl).then(() => 'opened' as const),
      abortPromise,
    ]);
    if (browserOrAbort === 'aborted') {
      return { kind: 'cancelled', reason: 'aborted by caller' };
    }

    const codeOrAbort = await Promise.race([codePromise, abortPromise]);
    if (codeOrAbort === 'aborted') {
      return { kind: 'cancelled', reason: 'aborted by caller' };
    }
    const { code } = codeOrAbort;

    // Complete the exchange via the SDK by feeding it the code. saveTokens runs
    // inside this call — the single commit point for the StoredOAuthRecord.
    // Thread resourceMetadataUrl through here as well: the provider does not
    // cache SDK discovery state, so this call rediscovers from scratch. Without
    // the metadata URL it would fall back to origin-based discovery and could
    // target the wrong token endpoint for servers whose authorization server is
    // only advertised through the resource metadata.
    await auth(provider, {
      serverUrl: input.serverUrl.toString(),
      authorizationCode: code,
      ...(input.resourceMetadataUrl ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
    });

    return { kind: 'success' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (isCancelledError(err)) {
      return { kind: 'cancelled', reason };
    }
    return { kind: 'failed', reason };
  } finally {
    await callback?.close();
  }
}

async function defaultOpenBrowser(url: URL): Promise<void> {
  const { default: open } = await import('open');
  await open(url.toString());
}

function abortToPromise(signal: AbortSignal): Promise<'aborted'> {
  if (signal.aborted) {
    return Promise.resolve('aborted');
  }
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve('aborted')));
}

function isCancelledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return /access_denied|cancel|abort|closed before redirect/i.test(msg);
}
