# F1-18 — `runOAuthLogin` orchestrator

**Milestone**: Phase 1 follow-up (OAuth upstream auth, orchestration)
**SPECS references**: §4.6.2 (browser flow ownership, atomicity)
**Depends on**: F1-13, F1-15, F1-16, F1-17

## Goal

A single async function that composes every OAuth primitive into the full browser-authentication flow used by both `tlbx auth login` and the auto-trigger inside `server add-http`. Inputs: server name, server URL, dependencies. Outputs: a typed result indicating success, user cancellation, or failure — no half-states.

## Motivation

SPECS §4.6.2 commits to atomicity: tokens are written only after the full flow completes; partial state never leaks. Centralizing the orchestration here means F1-19 (CLI commands) and F1-20 (`add-http` integration) call into the same code path — no two implementations to keep in sync.

## Deliverables

- **`packages/core/src/auth/oauth-login.ts`** — new file. Public surface:

  ```ts
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
     * Default: dynamically imports `open` (devDep). Tests inject a stub
     * that synthesizes a redirect to the callback server.
     */
    openBrowser?: (url: URL) => Promise<void>;
    /** Override the callback server's wait timeout. */
    callbackTimeoutMs?: number;
    /** Listen for cancellation (Ctrl-C / parent abort). */
    abortSignal?: AbortSignal;
  }

  export type RunOAuthLoginResult =
    | { kind: 'success' }
    | { kind: 'cancelled'; reason: string }
    | { kind: 'failed'; reason: string };

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
      // helper. We use the discovered value (NOT authorizationUrl.origin) as
      // the authoritative authorization_server identifier for the persisted
      // StoredOAuthRecord. authorizationUrl.origin would drop issuer-path
      // information (e.g. `https://issuer.example/auth/`) for OAuth servers
      // whose metadata is not rooted at the bare origin, and later refreshes
      // would target the wrong endpoint.
      const serverInfo = await discoverOAuthServerInfo(input.serverUrl.toString(), {
        ...(input.resourceMetadataUrl
          ? { resourceMetadataUrl: input.resourceMetadataUrl.toString() }
          : {}),
      });
      if (!serverInfo || !serverInfo.authorizationServerUrl) {
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

      // First half: discovery + (optional) DCR + build authorization URL.
      // The SDK calls provider.redirectToAuthorization, which we make throw
      // SuppressedRedirectError so we can intercept the URL and open the
      // browser ourselves at the moment of our choosing.
      let authorizationUrl: URL;
      try {
        await auth(provider, {
          serverUrl: input.serverUrl.toString(),
          ...(input.resourceMetadataUrl
            ? { resourceMetadataUrl: input.resourceMetadataUrl.toString() }
            : {}),
        });
        // If `auth()` returned without throwing, the SDK believed we already
        // had a usable token. Treat that as success.
        return { kind: 'success' };
      } catch (err) {
        if (err instanceof SuppressedRedirectError) {
          authorizationUrl = err.authorizationUrl;
        } else {
          throw err;
        }
      }

      // Second half: arm the callback server BEFORE opening the browser,
      // because a fast redirect could otherwise arrive while expectedStateRef
      // is still unset and be rejected as a state mismatch.
      const state = authorizationUrl.searchParams.get('state');
      if (!state) {
        return { kind: 'failed', reason: 'authorization URL missing state parameter' };
      }
      const codePromise = callback.waitForCode(state);
      // Attach a no-op rejection handler immediately. If cancellation wins
      // before we ever await `codePromise` (e.g. abort during openBrowser),
      // the `finally` block calls `callback.close()` which rejects this
      // promise — without this handler that's an unhandled rejection.
      // Legitimate rejections are still surfaced via the `await` in the
      // success path below; this only silences the dangling-promise case.
      void codePromise.catch(() => undefined);

      const abortPromise: Promise<'aborted'> = input.abortSignal
        ? abortToPromise(input.abortSignal)
        : new Promise(() => undefined);

      // Race the browser-open AGAINST the abort signal too — a slow or hung
      // `open` (e.g. when no default browser is registered) must not block
      // cancellation. If aborted during browser-open, bail before the
      // redirect arrives.
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

      // Complete the exchange via the SDK by feeding it the code.
      await auth(provider, {
        serverUrl: input.serverUrl.toString(),
        authorizationCode: code,
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
    if (signal.aborted) return Promise.resolve('aborted');
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve('aborted')));
  }

  function isCancelledError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : '';
    return /access_denied|cancel|abort|closed before redirect/i.test(msg);
  }
  ```

  **Caveat on `auth()` signature:** the exact name of the SDK's two-phase auth driver (and whether code-exchange is a separate function like `exchangeAuthorization`) must come from `@modelcontextprotocol/sdk@1.29.0`'s `client/auth.d.ts`. Adjust the orchestration accordingly. If the SDK provides a unified entry point that takes both `serverUrl` and an optional `authorizationCode`, use it. If it has separate `auth()` and `exchangeAuthorization()` calls, split the orchestrator accordingly.

- **`packages/core/package.json`** — add `open` as a runtime dependency (`^10.x` at task-execution time). It's tiny and cross-platform; preferring it over manually shelling out to `xdg-open`/`open`/`start`.

- **`packages/core/src/auth/__tests__/oauth-login.test.ts`** — integration-style tests with two test seams: a fake authorization server (HTTP) and a `openBrowser` stub.

  Create a fake auth server fixture at `packages/core/src/auth/__tests__/__fixtures__/fake-oauth-server.ts`:
  - Implements `/.well-known/oauth-authorization-server` returning DCR + auth + token endpoints.
  - Implements `/register` (DCR) — returns a fake `client_id`.
  - Implements `/authorize` — when hit, validates PKCE/state, redirects to the configured redirect URI with a code.
  - Implements `/token` — exchanges code for access/refresh tokens, also handles refresh_token grants.

  Tests using this fixture:
  - **Happy path:** `runOAuthLogin` with `openBrowser` stubbed to `fetch(authorizationUrl)` (which the fake server then redirects to the callback). Assert result `{ kind: 'success' }` and TokenStore has a record with the issued tokens.
  - **User cancel via abort signal:** start, abort immediately. Assert result `{ kind: 'cancelled', reason: 'aborted by caller' }` and no token written.
  - **User cancel via OAuth error:** fake server's `/authorize` redirects with `?error=access_denied`. Assert `{ kind: 'cancelled', reason: <contains access_denied> }` and no token.
  - **Refresh-token path (skip browser):** pre-seed an existing valid token in the store. Assert `runOAuthLogin` returns `{ kind: 'success' }` without ever calling `openBrowser` (assert the stub was not invoked).
  - **State mismatch:** make the fake server tamper with state in the redirect. Assert `{ kind: 'failed', reason: <contains state> }`.

- **`packages/core/src/auth/index.ts`** — export `runOAuthLogin`, `RunOAuthLoginInput`, `RunOAuthLoginResult`.

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- `runOAuthLogin` is the only public composition point between TokenStore, callback server, provider, and SDK auth helpers. Verify by checking that `apps/cli` doesn't import any of those primitives directly — only `runOAuthLogin` and the bare `TokenStore` interface.
- Atomicity: at every failure branch, the TokenStore record at `serverName` is either absent (if no prior token existed) or unchanged (if a refresh attempt failed). Tested explicitly.
- `openBrowser` is fully injectable; no test triggers a real browser.
- `abortSignal` cancellation closes the callback server promptly (verified by a test that the next bind on the same port-range succeeds).

## Out of scope

- CLI command implementations — F1-19.
- `add-http` integration — F1-20.
- Refresh during steady-state gateway operation — F1-21 (separate code path, uses the same provider).

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
