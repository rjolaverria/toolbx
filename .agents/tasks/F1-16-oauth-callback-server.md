# F1-16 — OAuth callback server (loopback redirect target)

**Milestone**: Phase 1 follow-up (OAuth upstream auth, protocol primitives)
**SPECS references**: §4.6.2 (browser flow ownership), invariant from design §3.6
**Depends on**: — (independent)

## Goal

A short-lived HTTP server on `127.0.0.1:<ephemeral>` that the OAuth login flow uses as its redirect URI. Accepts one redirect, validates `state`, hands the `code` back to the caller, serves a friendly close-this-tab page, and shuts down.

## Motivation

The authorization-code flow requires a loopback HTTP server to catch the redirect from the browser. SPECS §4.6.2 commits to loopback-only binding and explicit user-driven login (no spawned-child browser surprises). This task implements the server primitive; F1-18 composes it with the SDK auth helpers.

## Deliverables

- **`packages/core/src/auth/oauth-callback-server.ts`** — new file:

  ```ts
  import { createServer, type Server } from 'node:http';
  import { AddressInfo } from 'node:net';
  import type { Logger } from '../logging/logger.js';

  export interface StartCallbackServerOpts {
    logger: Logger;
    /** Default 5 minutes. */
    timeoutMs?: number;
  }

  export interface CallbackServer {
    readonly redirectUri: URL;
    /**
     * The bound address the underlying server is listening on. Exposed so the
     * loopback-only invariant can be asserted from tests without reaching into
     * the private `server` reference. Always `'127.0.0.1'` in production.
     */
    readonly host: string;
    /** Resolves with the received {code, state}. Rejects on timeout, abort, or duplicate redirect. */
    waitForCode(expectedState: string): Promise<{ code: string; state: string }>;
    /** Idempotent. Safe to call from finally blocks. */
    close(): Promise<void>;
  }

  const DEFAULT_TIMEOUT_MS = 5 * 60_000;

  export async function startCallbackServer(
    opts: StartCallbackServerOpts,
  ): Promise<CallbackServer> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const log = opts.logger.child({ component: 'oauth-callback-server' });

    let resolveCode: ((value: { code: string; state: string }) => void) | null = null;
    let rejectCode: ((reason: Error) => void) | null = null;
    const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    let received = false;
    let server: Server | null = null;

    let expectedStateRef: string | null = null;

    server = createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end('Bad request');
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      if (received) {
        // Second redirect after we already accepted one — refuse.
        res.statusCode = 409;
        res.end('Callback already consumed');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      // Validate `state` BEFORE branching on success vs error. Without this,
      // any unauthenticated loopback request with `?error=...` could cancel
      // an in-flight authorization attempt — defense in depth even though
      // the listener is loopback-bound.
      if (!state) {
        res.statusCode = 400;
        res.end('Missing state');
        return;
      }
      if (expectedStateRef === null) {
        // Pre-arming: the request arrived before the caller called
        // `waitForCode(expectedState)`. With F1-18's fix that arms the
        // callback before opening the browser, this branch is reachable
        // only by a stray loopback request that races the legitimate
        // redirect. Return 400 and keep the codePromise alive — the real
        // redirect (with the matching state) may still arrive.
        res.statusCode = 400;
        res.end('State parameter mismatch');
        return;
      }
      if (state !== expectedStateRef) {
        // Post-arming: someone hit the callback URL claiming a state, but
        // it's not the one we're expecting. Fail-fast: either the real
        // attempt was hijacked or a stale request is colliding with our
        // active flow. Reject the active attempt; the caller decides
        // whether to retry.
        res.statusCode = 400;
        res.end('State parameter mismatch');
        rejectCode?.(new Error('State parameter mismatch'));
        return;
      }

      // State is verified to belong to the active attempt — now branch.
      if (error) {
        received = true;
        res.statusCode = 400;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(renderErrorPage(error));
        rejectCode?.(new Error(`Authorization failed: ${error}`));
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.end('Missing code');
        return;
      }
      received = true;
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(renderSuccessPage());
      resolveCode?.({ code, state });
    });

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      // CRITICAL: bind loopback-only. Never change this literal.
      server!.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address() as AddressInfo;
    const redirectUri = new URL(`http://127.0.0.1:${addr.port}/callback`);
    log.debug({ port: addr.port }, 'callback server listening');

    const timer = setTimeout(() => {
      rejectCode?.(new Error(`Callback timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      // Reject any outstanding waiter so callers awaiting `waitForCode` don't
      // hang when the server is closed before a redirect arrives (matches the
      // acceptance criterion in the test list below).
      if (!received) {
        rejectCode?.(new Error('Callback server closed before redirect'));
      }
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
    };

    // The caller (F1-18 / runOAuthLogin) is responsible for calling close()
    // in its own try/finally — we do NOT auto-close from a codePromise
    // continuation. Earlier sketches used `codePromise.finally(() => void
    // close())`, but that creates an unhandled rejection when codePromise
    // rejects (the .finally chain re-throws into a dangling promise), and it
    // also closes the server out from under callers who may still want to
    // serve a 409 to a duplicate redirect.

    return {
      redirectUri,
      host: '127.0.0.1',
      async waitForCode(expectedState: string) {
        expectedStateRef = expectedState;
        return codePromise;
      },
      close,
    };
  }

  function renderSuccessPage(): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>ToolBox — authenticated</title>
      <style>body{font-family:system-ui,sans-serif;max-width:480px;margin:6rem auto;text-align:center}</style>
      </head><body><h1>✓ Authenticated</h1><p>You can close this tab and return to your terminal.</p></body></html>`;
  }

  function renderErrorPage(error: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>ToolBox — auth failed</title>
      <style>body{font-family:system-ui,sans-serif;max-width:480px;margin:6rem auto;text-align:center}</style>
      </head><body><h1>Authentication failed</h1><pre>${escapeHtml(error)}</pre>
      <p>Return to your terminal for next steps.</p></body></html>`;
  }

  function escapeHtml(s: string): string {
    return s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  }
  ```

- **`packages/core/src/auth/__tests__/oauth-callback-server.test.ts`** — tests against a real running server on an ephemeral port:
  - **Happy path:** start server, `waitForCode('abc')`, `fetch(redirectUri + '?code=x&state=abc')`, assert promise resolves to `{ code: 'x', state: 'abc' }` and response is 200 with HTML body containing "Authenticated".
  - **State mismatch (post-arming):** `waitForCode('abc')`, `fetch(redirectUri + '?code=x&state=wrong')`, assert promise rejects with `'State parameter mismatch'` and HTTP response is 400. (Active attempt is now invalidated.)
  - **State present pre-arming:** `fetch(redirectUri + '?code=x&state=abc')` **before** calling `waitForCode('abc')`. Assert 400 "State parameter mismatch" and codePromise is **still pending**. Then call `waitForCode('abc')` and `fetch(redirectUri + '?code=y&state=abc')` again — assert this second request now resolves the promise with `{ code: 'y', state: 'abc' }`. (Stray pre-arming requests don't kill the flow; the real redirect that races them is still accepted once `waitForCode` arms.)
  - **OAuth `error` parameter (with matching state):** `waitForCode('abc')`, `fetch(redirectUri + '?error=access_denied&state=abc')`, assert promise rejects with `'Authorization failed: access_denied'` and HTTP response is 400 with the error HTML.
  - **OAuth `error` parameter without state (defense in depth):** `waitForCode('abc')`, `fetch(redirectUri + '?error=access_denied')` (no state), assert 400 "Missing state", **codePromise still pending** (state validation gates the error path, so unauthenticated requests can't cancel the flow).
  - **OAuth `error` parameter with wrong state:** `waitForCode('abc')`, `fetch(redirectUri + '?error=access_denied&state=wrong')`, assert 400 "State parameter mismatch" and codePromise rejects with `'State parameter mismatch'` — not the `access_denied` error. (The mismatch is a signal that someone is claiming the wrong state and we should bail the active attempt.)
  - **Missing state on success request:** `fetch(redirectUri + '?code=x')`, assert 400 "Missing state", promise still pending.
  - **Missing code (state-only):** `waitForCode('abc')`, `fetch(redirectUri + '?state=abc')`, assert 400 "Missing code", promise still pending.
  - **Wrong path:** `fetch(redirectUri.origin + '/other')`, assert 404; promise still pending.
  - **Duplicate redirect:** valid redirect resolves the promise; without calling `close()`, fire a second `fetch` to `redirectUri + '?code=y&state=abc'` and assert it returns 409. Then explicitly `close()`. (The server only stops listening when the caller closes it — this test depends on that property, so don't reintroduce the auto-close-on-codePromise behavior.)
  - **Timeout:** start with `timeoutMs: 50`, do nothing, assert promise rejects with `'Callback timed out after 50ms'` within 100ms.
  - **`close()` is idempotent:** call twice; both resolve; assert server is no longer listening (a subsequent `fetch` to `redirectUri` rejects with connection error).
  - **Loopback-only binding:** assert `callbackServer.host === '127.0.0.1'` and `callbackServer.redirectUri.hostname === '127.0.0.1'`. The `host` field is part of the public interface for exactly this test; any change that broadens the bind (e.g. switching the `listen(0, '127.0.0.1', ...)` literal to `'0.0.0.0'`) must also flip `host`, which would fail this assertion. Belt-and-suspenders.
  - **Promise rejects on close-before-redirect:** start server, `waitForCode('abc')`, immediately `close()`. Assert codePromise rejects with `'Callback server closed before redirect'` (matches the `if (!received) rejectCode?.(...)` in `close()`).

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- Loopback-binding test is present and passing (this is the SPECS §4.6.2 invariant).
- Timeout default is 5 minutes; configurable; tested with fake timers or a short real timeout.
- `close()` is idempotent and resolves outstanding promises.
- Success page renders the "you can close this tab" copy.

## Out of scope

- Composing this server with `OAuthClientProvider` and the SDK's `auth()` helper — that's F1-18.
- Persistent / reusable callback ports — every login flow uses a fresh ephemeral port.
- Localized success/error pages.

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
