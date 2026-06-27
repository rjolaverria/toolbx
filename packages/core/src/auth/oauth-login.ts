import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

import type { Logger } from '../logging/logger.js';
import { startCallbackServer, type CallbackServer } from './oauth-callback-server.js';
import { SuppressedRedirectError, ToolbxOAuthProvider } from './oauth-provider.js';
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
  const parentSignal = input.abortSignal;

  // Short-circuit a signal that is already aborted before doing any
  // side-effecting work. Without this, the first `auth()` call below could
  // refresh an existing token and overwrite the TokenStore — reporting
  // success for an operation the caller already cancelled.
  if (parentSignal?.aborted) {
    return { kind: 'cancelled', reason: 'aborted by caller' };
  }

  // Link the (possibly long-lived, reused) parent signal to a per-call
  // controller. Every fetch and the browser race listen on this local
  // controller's signal, which is discarded with the call — so the parent only
  // ever carries the single link listener we remove in `finally`. Routing the
  // fetches through the parent directly would instead leave one undici abort
  // listener per request stranded on it, accumulating across logins until it
  // trips MaxListenersExceededWarning.
  const abortController = new AbortController();
  let disposeAbortLink: () => void = () => undefined;
  if (parentSignal) {
    const onParentAbort = (): void => abortController.abort();
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    disposeAbortLink = () => parentSignal.removeEventListener('abort', onParentAbort);
  }
  const signal = abortController.signal;

  // Make every SDK network call abort-aware. The SDK runs discovery (and, on
  // the early-success path, a token refresh) inside the first `auth()` call;
  // routing those fetches through the (linked) abort signal means a
  // cancellation during discovery/refresh aborts the request and throws before
  // `saveTokens` can write, preserving atomicity.
  const fetchFn: typeof fetch = (url, init) => fetch(url, { ...init, signal });

  let callback: CallbackServer | null = null;
  try {
    callback = await startCallbackServer({
      logger: input.logger,
      ...(input.callbackTimeoutMs !== undefined ? { timeoutMs: input.callbackTimeoutMs } : {}),
    });

    // Discovery is owned entirely by the SDK's auth() calls below. The provider
    // implements saveDiscoveryState/discoveryState, so the first auth() resolves
    // the authorization server once, caches it, and persists it with the tokens;
    // the code-exchange auth() reuses that cache instead of rediscovering. This
    // keeps DCR/authorize, the exchange, and the stored issuer in agreement even
    // if the upstream metadata would change between calls.
    const provider = new ToolbxOAuthProvider({
      serverName: input.serverName,
      redirectUrl: callback.redirectUri,
      ...(input.scopes ? { scopes: input.scopes } : {}),
      tokenStore: input.tokenStore,
      logger: input.logger,
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
        fetchFn,
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

    // Listens on the local linked signal, so the listener is discarded with the
    // call rather than stranded on a reused parent signal.
    const abortPromise = abortToPromise(signal);

    // Re-check cancellation before opening the browser. The discovery/DCR phase
    // above can take time, and a Ctrl-C landing in the local window between the
    // last network call and here would otherwise still pop a browser tab — the
    // abort-aware fetchFn only cancels in-flight requests, not this gap.
    if (signal.aborted) {
      return { kind: 'cancelled', reason: 'aborted by caller' };
    }

    // Launch the browser, then wait for the real terminal signals: the redirect
    // code, an abort, or the callback timeout (codePromise rejecting). A
    // successful launch only means the tab opened — not that auth finished — so
    // it must NOT settle this race; a *failed* launch is terminal (we'll never
    // reach consent). Critically, a hung `openBrowser` must not block the flow
    // even when no abortSignal is wired, so we never await the opener directly:
    // the callback timeout still rescues us.
    log.info({ url: authorizationUrl.toString() }, 'opening browser for authorization');
    const browserFailure: Promise<Error> = openBrowser(authorizationUrl).then(
      () => new Promise<never>(() => undefined),
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );

    const settled = await Promise.race([abortPromise, browserFailure, codePromise]);
    if (settled === 'aborted') {
      return { kind: 'cancelled', reason: 'aborted by caller' };
    }
    if (settled instanceof Error) {
      return { kind: 'failed', reason: `failed to open browser: ${settled.message}` };
    }
    const { code } = settled;

    // Complete the exchange via the SDK by feeding it the code. saveTokens runs
    // inside this call — the single commit point for the StoredOAuthRecord.
    // Thread resourceMetadataUrl through here as well: the provider does not
    // cache SDK discovery state, so this call rediscovers from scratch. Without
    // the metadata URL it would fall back to origin-based discovery and could
    // target the wrong token endpoint for servers whose authorization server is
    // only advertised through the resource metadata.
    provider.useDiscoveredResourceForAuthorizationCodeExchange();
    await auth(provider, {
      serverUrl: input.serverUrl.toString(),
      authorizationCode: code,
      ...(input.resourceMetadataUrl ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
      fetchFn,
    });

    return { kind: 'success' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (isCancelledError(err, signal)) {
      return { kind: 'cancelled', reason };
    }
    return { kind: 'failed', reason };
  } finally {
    disposeAbortLink();
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
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve('aborted'), { once: true }),
  );
}

/**
 * Distinguishes a user cancellation from a genuine failure. Cancellation is
 * keyed off the actual abort-signal state — when we aborted, the resulting
 * throw (an AbortError from a fetch, a closed callback, etc.) is a cancellation
 * regardless of its wording — plus the one explicit OAuth user-denial code
 * (`access_denied`, RFC 6749 §4.1.2.1). Deliberately NOT broad substring
 * matching on "cancel"/"abort": a real failure whose message merely contains
 * those words (e.g. a proxy reporting "request was cancelled") must surface as
 * a failure, not be silently swallowed.
 */
function isCancelledError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  const msg = err instanceof Error ? err.message : '';
  return /\baccess_denied\b/i.test(msg);
}
