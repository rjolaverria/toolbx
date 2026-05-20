import { afterEach, describe, expect, it } from 'vitest';

import { createNoopLogger } from '../../logging/logger.js';
import { startCallbackServer, type CallbackServer } from '../oauth-callback-server.js';

let activeServer: CallbackServer | null = null;

async function start(timeoutMs?: number): Promise<CallbackServer> {
  const server = await startCallbackServer({
    logger: createNoopLogger(),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  activeServer = server;
  return server;
}

function callbackUrl(server: CallbackServer, query: string): string {
  return `${server.redirectUri.toString()}?${query}`;
}

afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }
});

describe('startCallbackServer', () => {
  it('resolves with the code and state on a valid redirect', async () => {
    const server = await start();
    const codePromise = server.waitForCode('abc');
    const res = await fetch(callbackUrl(server, 'code=x&state=abc'));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Authenticated');
    await expect(codePromise).resolves.toEqual({ code: 'x', state: 'abc' });
  });

  it('rejects and returns 400 when state does not match (post-arming)', async () => {
    const server = await start();
    // Attach the rejection assertion before triggering the redirect: the
    // handler must be registered before the request settles the flow, or the
    // rejection is briefly observed as unhandled. Real callers (runOAuthLogin)
    // await waitForCode directly, so this ordering matches production usage.
    const rejection = expect(server.waitForCode('abc')).rejects.toThrow('State parameter mismatch');
    const res = await fetch(callbackUrl(server, 'code=x&state=wrong'));

    expect(res.status).toBe(400);
    await rejection;
  });

  it('keeps the flow alive when a stray request arrives before arming', async () => {
    const server = await start();
    const preArm = await fetch(callbackUrl(server, 'code=x&state=abc'));
    expect(preArm.status).toBe(400);
    expect(await preArm.text()).toContain('State parameter mismatch');

    const codePromise = server.waitForCode('abc');
    const res = await fetch(callbackUrl(server, 'code=y&state=abc'));
    expect(res.status).toBe(200);
    await expect(codePromise).resolves.toEqual({ code: 'y', state: 'abc' });
  });

  it('rejects with the OAuth error when state matches', async () => {
    const server = await start();
    const rejection = expect(server.waitForCode('abc')).rejects.toThrow(
      'Authorization failed: access_denied',
    );
    const res = await fetch(callbackUrl(server, 'error=access_denied&state=abc'));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('access_denied');
    await rejection;
  });

  it('gates the error path on state: an error without state does not cancel the flow', async () => {
    const server = await start();
    const codePromise = server.waitForCode('abc');
    let settled = false;
    void codePromise.then(
      () => (settled = true),
      () => (settled = true),
    );

    const res = await fetch(callbackUrl(server, 'error=access_denied'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Missing state');

    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it('rejects with state mismatch (not the OAuth error) when an error has the wrong state', async () => {
    const server = await start();
    const rejection = expect(server.waitForCode('abc')).rejects.toThrow('State parameter mismatch');
    const res = await fetch(callbackUrl(server, 'error=access_denied&state=wrong'));

    expect(res.status).toBe(400);
    await rejection;
  });

  it('returns 400 Missing state on a success request without state', async () => {
    const server = await start();
    const codePromise = server.waitForCode('abc');
    let settled = false;
    void codePromise.then(
      () => (settled = true),
      () => (settled = true),
    );

    const res = await fetch(callbackUrl(server, 'code=x'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Missing state');

    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it('returns 400 Missing code when only state is present', async () => {
    const server = await start();
    const codePromise = server.waitForCode('abc');
    let settled = false;
    void codePromise.then(
      () => (settled = true),
      () => (settled = true),
    );

    const res = await fetch(callbackUrl(server, 'state=abc'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Missing code');

    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it('returns 404 for an unknown path and keeps the flow alive', async () => {
    const server = await start();
    const codePromise = server.waitForCode('abc');
    let settled = false;
    void codePromise.then(
      () => (settled = true),
      () => (settled = true),
    );

    const res = await fetch(`${server.redirectUri.origin}/other`);
    expect(res.status).toBe(404);

    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it('returns 409 on a duplicate redirect after one was consumed', async () => {
    const server = await start();
    const codePromise = server.waitForCode('abc');
    const first = await fetch(callbackUrl(server, 'code=x&state=abc'));
    expect(first.status).toBe(200);
    await expect(codePromise).resolves.toEqual({ code: 'x', state: 'abc' });

    const second = await fetch(callbackUrl(server, 'code=y&state=abc'));
    expect(second.status).toBe(409);
  });

  it('rejects with a timeout error after the configured timeout', async () => {
    const server = await start(50);
    const codePromise = server.waitForCode('abc');
    await expect(codePromise).rejects.toThrow('Callback timed out after 50ms');
  });

  it('close() is idempotent and stops listening', async () => {
    const server = await start();
    const redirectUri = server.redirectUri.toString();
    await expect(server.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it('binds loopback-only', async () => {
    const server = await start();
    expect(server.host).toBe('127.0.0.1');
    expect(server.redirectUri.hostname).toBe('127.0.0.1');
  });

  it('rejects the outstanding promise when closed before a redirect', async () => {
    const server = await start();
    const rejection = expect(server.waitForCode('abc')).rejects.toThrow(
      'Callback server closed before redirect',
    );
    await server.close();
    await rejection;
  });
});
