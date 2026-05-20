import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNoopLogger } from '../../logging/logger.js';
import { probeUpstreamAuth } from '../oauth-discovery.js';

const URL_UNDER_TEST = new URL('https://mcp.example.com/');

function deps(fetchFn: typeof fetch, timeoutMs?: number) {
  return {
    logger: createNoopLogger(),
    fetchFn,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function fetchReturning(res: Response): typeof fetch {
  return vi.fn(() => Promise.resolve(res));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('probeUpstreamAuth', () => {
  it('classifies a 200 OK response as no auth required', async () => {
    const res = new Response('{}', { status: 200 });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'none',
    });
  });

  it('terminates the MCP session opened by a successful 200 probe', async () => {
    const calls: Array<{ method: string; headers: Record<string, string> }> = [];
    const fetchFn = vi.fn(
      (_url: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
        const method = init?.method ?? 'GET';
        calls.push({ method, headers: init?.headers ?? {} });
        if (method === 'POST') {
          return Promise.resolve(
            new Response('{}', { status: 200, headers: { 'mcp-session-id': 'sess-123' } }),
          );
        }
        return Promise.resolve(new Response('', { status: 200 }));
      },
    ) as unknown as typeof fetch;

    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchFn))).resolves.toEqual({
      kind: 'none',
    });
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del?.headers['mcp-session-id']).toBe('sess-123');
  });

  it('does not attempt session cleanup on a 200 without mcp-session-id', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch;
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchFn))).resolves.toEqual({
      kind: 'none',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('selects the Bearer challenge in a multi-challenge header', async () => {
    const metadataUrl = 'https://x.example/.well-known/oauth-protected-resource';
    const res = new Response('', {
      status: 401,
      headers: { 'WWW-Authenticate': `Basic realm="x", Bearer resource_metadata="${metadataUrl}"` },
    });
    const hint = await probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)));
    expect(hint).toEqual({ kind: 'oauth', resourceMetadataUrl: new URL(metadataUrl) });
  });

  it('does not attribute a preceding challenge resource_metadata to Bearer', async () => {
    const res = new Response('', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic resource_metadata="https://wrong.example/", Bearer realm="api"',
      },
    });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'bearer',
      realm: 'api',
    });
  });

  it('reads the realm from the Bearer challenge, not a preceding Basic challenge', async () => {
    const res = new Response('', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="basic", Bearer realm="api"' },
    });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'bearer',
      realm: 'api',
    });
  });

  it('finds the Bearer challenge past an escaped quote in a preceding challenge', async () => {
    const res = new Response('', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Digest realm="a\\",b", Bearer realm="api"' },
    });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'bearer',
      realm: 'api',
    });
  });

  it('does not treat a Bearer-Token scheme as a Bearer challenge', async () => {
    const res = new Response('nope', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer-Token realm="x"' },
    });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'unknown',
      status: 401,
      body: 'nope',
    });
  });

  it('does not treat a similarly named param as resource_metadata', async () => {
    const res = new Response('', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer not_resource_metadata="https://wrong.example/"' },
    });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'bearer',
      realm: undefined,
    });
  });

  it('cancels the body stream on a streaming 200 response', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // Never enqueues/closes — simulates an open event-stream that would
        // keep the socket alive unless the probe cancels it.
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'none',
    });
    expect(cancelled).toBe(true);
  });

  it('classifies a 401 with resource_metadata as oauth', async () => {
    const metadataUrl = 'https://x.example/.well-known/oauth-protected-resource';
    const res = new Response('', {
      status: 401,
      headers: { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"` },
    });
    const hint = await probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)));
    expect(hint).toEqual({ kind: 'oauth', resourceMetadataUrl: new URL(metadataUrl) });
  });

  it('classifies a 401 with extra whitespace before resource_metadata as oauth', async () => {
    const metadataUrl = 'https://x.example/.well-known/oauth-protected-resource';
    const res = new Response('', {
      status: 401,
      headers: { 'WWW-Authenticate': `Bearer    resource_metadata="${metadataUrl}"` },
    });
    const hint = await probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)));
    expect(hint).toEqual({ kind: 'oauth', resourceMetadataUrl: new URL(metadataUrl) });
  });

  it('classifies a 401 with realm but no resource_metadata as bearer', async () => {
    const res = new Response('', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer realm="foo"' },
    });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'bearer',
      realm: 'foo',
    });
  });

  it('classifies a 401 with no WWW-Authenticate header as bearer with undefined realm', async () => {
    const res = new Response('', { status: 401 });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'bearer',
      realm: undefined,
    });
  });

  it('classifies a 401 with a non-Bearer (Basic) challenge as unknown', async () => {
    const res = new Response('nope', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="foo"' },
    });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'unknown',
      status: 401,
      body: 'nope',
    });
  });

  it('classifies a 403 as unknown with a body excerpt', async () => {
    const res = new Response('forbidden', { status: 403 });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'unknown',
      status: 403,
      body: 'forbidden',
    });
  });

  it('classifies a 404 as unknown', async () => {
    const res = new Response('', { status: 404 });
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)))).resolves.toEqual({
      kind: 'unknown',
      status: 404,
      body: '',
    });
  });

  it('truncates a body excerpt larger than 512 bytes', async () => {
    const longBody = 'a'.repeat(600);
    const res = new Response(longBody, { status: 500 });
    const hint = await probeUpstreamAuth(URL_UNDER_TEST, deps(fetchReturning(res)));
    expect(hint).toEqual({
      kind: 'unknown',
      status: 500,
      body: 'a'.repeat(512) + '…',
    });
  });

  it('does not propagate a network error', async () => {
    const fetchFn = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as typeof fetch;
    await expect(probeUpstreamAuth(URL_UNDER_TEST, deps(fetchFn))).resolves.toEqual({
      kind: 'unknown',
      status: 0,
    });
  });

  it('aborts and returns unknown after the configured timeout', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;

    const promise = probeUpstreamAuth(URL_UNDER_TEST, deps(fetchFn, 5_000));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toEqual({ kind: 'unknown', status: 0 });
  });
});
