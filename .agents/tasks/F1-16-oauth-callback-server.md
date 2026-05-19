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

      if (error) {
        received = true;
        res.statusCode = 400;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(renderErrorPage(error));
        rejectCode?.(new Error(`Authorization failed: ${error}`));
        return;
      }
      if (!code || !state) {
        res.statusCode = 400;
        res.end('Missing code or state');
        return;
      }
      if (expectedStateRef === null || state !== expectedStateRef) {
        res.statusCode = 400;
        res.end('State parameter mismatch');
        rejectCode?.(new Error('State parameter mismatch'));
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
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
    };

    codePromise.finally(() => void close());

    return {
      redirectUri,
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
  - **State mismatch:** `waitForCode('abc')`, `fetch(redirectUri + '?code=x&state=wrong')`, assert promise rejects with `'State parameter mismatch'` and HTTP response is 400.
  - **OAuth `error` parameter:** `fetch(redirectUri + '?error=access_denied')`, assert promise rejects with `'Authorization failed: access_denied'` and HTTP response is 400 with the error HTML.
  - **Missing code/state:** `fetch(redirectUri + '?code=x')`, assert 400, promise still pending. (Then close server; assert promise rejects on close — see below.)
  - **Wrong path:** `fetch(redirectUri.origin + '/other')`, assert 404; promise still pending.
  - **Duplicate redirect:** valid redirect resolves the promise; a second `fetch` to `redirectUri + '?code=y&state=abc'` returns 409.
  - **Timeout:** start with `timeoutMs: 50`, do nothing, assert promise rejects with `'Callback timed out after 50ms'` within 100ms.
  - **`close()` is idempotent:** call twice; both resolve; assert server is no longer listening (a subsequent `fetch` to `redirectUri` rejects with connection error).
  - **Loopback-only binding:** assert `server.address().address === '127.0.0.1'` after `listen`. This locks the invariant in CI — any change that broadens the bind will fail this test.
  - **Promise rejects on close-before-redirect:** start server, `waitForCode('abc')`, immediately `close()`. The codePromise should... wait, actually with the current implementation `close()` doesn't reject the promise. Decide: either (a) add explicit rejection on `close()` for unresolved promises, or (b) document that callers must `Promise.race` with their own cancellation signal. **Pick (a)**: in the `close()` body, call `rejectCode?.(new Error('Callback server closed before redirect'))` if `!received`. Update the implementation and add this test.

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
