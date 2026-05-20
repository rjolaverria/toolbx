import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

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

interface CodeResult {
  code: string;
  state: string;
}

type Settlement = { ok: true; value: CodeResult } | { ok: false; error: Error };

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export async function startCallbackServer(opts: StartCallbackServerOpts): Promise<CallbackServer> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.logger.child({ component: 'oauth-callback-server' });

  // The flow is modelled as a single settlement that is recorded exactly once
  // (first writer wins). `waitForCode` materialises a promise from this record
  // on demand. Recording the outcome instead of rejecting a pre-created promise
  // means a settlement with no awaiting caller (e.g. `close()` before anyone
  // calls `waitForCode`) never produces a floating, unhandled rejection.
  let settlement: Settlement | null = null;
  const waiters: Array<() => void> = [];

  function settle(next: Settlement): void {
    if (settlement) {
      return;
    }
    settlement = next;
    // Release every outstanding waiter, not just the most recent one, so
    // multiple (e.g. layered orchestration / retry) callers of waitForCode
    // all observe the settlement instead of hanging.
    while (waiters.length > 0) {
      waiters.pop()?.();
    }
  }

  let expectedStateRef: string | null = null;

  const server: Server = createServer((req, res) => {
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
    if (settlement) {
      // The flow already reached a terminal state — a consumed success, a
      // matched-error rejection, a state mismatch, or a timeout. Refuse any
      // further redirect: a late `?code&state` arriving after a failure must
      // not be answered with a success page for a code that will never be
      // exchanged. Stray pre-arming requests that returned 4xx without
      // settling are NOT terminal, so the real redirect can still arrive.
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
      // redirect. Return 400 and keep the flow alive — the real redirect
      // (with the matching state) may still arrive.
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
      settle({ ok: false, error: new Error('State parameter mismatch') });
      return;
    }

    // State is verified to belong to the active attempt — now branch.
    if (error) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(renderErrorPage(error));
      settle({ ok: false, error: new Error(`Authorization failed: ${error}`) });
      return;
    }
    if (!code) {
      res.statusCode = 400;
      res.end('Missing code');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(renderSuccessPage());
    settle({ ok: true, value: { code, state } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // CRITICAL: bind loopback-only. Never change this literal.
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const redirectUri = new URL(`http://127.0.0.1:${addr.port}/callback`);
  log.debug({ port: addr.port }, 'callback server listening');

  const timer = setTimeout(() => {
    settle({ ok: false, error: new Error(`Callback timed out after ${timeoutMs}ms`) });
  }, timeoutMs);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    clearTimeout(timer);
    // Settle any outstanding waiter so callers awaiting `waitForCode` don't
    // hang when the server is closed before the flow reached a terminal state.
    // `settle` is first-writer-wins, so a prior success/failure is preserved.
    settle({ ok: false, error: new Error('Callback server closed before redirect') });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    redirectUri,
    host: '127.0.0.1',
    async waitForCode(expectedState: string) {
      expectedStateRef = expectedState;
      if (!settlement) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      const result = settlement!;
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
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
