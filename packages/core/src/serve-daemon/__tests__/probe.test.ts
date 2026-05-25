import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultProbeDeps,
  probeDaemonEndpoint,
  waitForDaemonReady,
  type ProbeDeps,
  type WaitForDaemonReadyDeps,
} from '../probe.js';

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

async function startServer(handler: (status: number) => number): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(handler(200));
    res.end('ok');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}/mcp`;
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('probeDaemonEndpoint', () => {
  it('reports reachable with the status code on any HTTP response', async () => {
    const deps: ProbeDeps = { httpGet: () => Promise.resolve(400) };

    const outcome = await probeDaemonEndpoint('http://127.0.0.1:7331/mcp', 100, deps);

    expect(outcome).toEqual({ reachable: true, status: 400 });
  });

  it('classifies a refused connection', async () => {
    const deps: ProbeDeps = { httpGet: () => Promise.reject(errnoError('ECONNREFUSED')) };

    const outcome = await probeDaemonEndpoint('http://127.0.0.1:7331/mcp', 100, deps);

    expect(outcome).toEqual({ reachable: false, reason: 'refused' });
  });

  it('classifies a timeout', async () => {
    const deps: ProbeDeps = { httpGet: () => Promise.reject(errnoError('ETIMEDOUT')) };

    const outcome = await probeDaemonEndpoint('http://127.0.0.1:7331/mcp', 100, deps);

    expect(outcome).toEqual({ reachable: false, reason: 'timeout' });
  });

  it('classifies other transport errors and keeps the message', async () => {
    const deps: ProbeDeps = { httpGet: () => Promise.reject(new Error('boom')) };

    const outcome = await probeDaemonEndpoint('http://127.0.0.1:7331/mcp', 100, deps);

    expect(outcome).toEqual({ reachable: false, reason: 'error', message: 'boom' });
  });
});

interface PollHarness {
  deps: WaitForDaemonReadyDeps;
  attempts: () => number;
  sleeps: () => number[];
}

function makePollHarness(results: Array<number | NodeJS.ErrnoException>): PollHarness {
  let attempt = 0;
  let clock = 0;
  const sleeps: number[] = [];
  const deps: WaitForDaemonReadyDeps = {
    httpGet: () => {
      const result = results[attempt] ?? errnoError('ECONNREFUSED');
      attempt += 1;
      return typeof result === 'number' ? Promise.resolve(result) : Promise.reject(result);
    },
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
  return { deps, attempts: () => attempt, sleeps: () => sleeps };
}

describe('waitForDaemonReady', () => {
  it('returns true on the first reachable probe without sleeping', async () => {
    const h = makePollHarness([200]);

    const ready = await waitForDaemonReady(
      'http://127.0.0.1:7331/mcp',
      { timeoutMs: 1_000, intervalMs: 50, attemptTimeoutMs: 100 },
      h.deps,
    );

    expect(ready).toBe(true);
    expect(h.attempts()).toBe(1);
    expect(h.sleeps()).toEqual([]);
  });

  it('polls until the endpoint becomes reachable', async () => {
    const h = makePollHarness([errnoError('ECONNREFUSED'), errnoError('ECONNREFUSED'), 400]);

    const ready = await waitForDaemonReady(
      'http://127.0.0.1:7331/mcp',
      { timeoutMs: 1_000, intervalMs: 50, attemptTimeoutMs: 100 },
      h.deps,
    );

    expect(ready).toBe(true);
    expect(h.attempts()).toBe(3);
    expect(h.sleeps()).toEqual([50, 50]);
  });

  it('returns false once the timeout budget is exhausted', async () => {
    // Always refused; budget allows ~2 sleeps of 50ms within 100ms.
    const h = makePollHarness([]);

    const ready = await waitForDaemonReady(
      'http://127.0.0.1:7331/mcp',
      { timeoutMs: 100, intervalMs: 50, attemptTimeoutMs: 10 },
      h.deps,
    );

    expect(ready).toBe(false);
    // Probes at t=0, t=50; at t=100 the next sleep would cross the deadline.
    expect(h.attempts()).toBe(2);
  });

  it('always probes at least once even with a zero budget', async () => {
    const h = makePollHarness([200]);

    const ready = await waitForDaemonReady(
      'http://127.0.0.1:7331/mcp',
      { timeoutMs: 0, intervalMs: 50, attemptTimeoutMs: 10 },
      h.deps,
    );

    expect(ready).toBe(true);
    expect(h.attempts()).toBe(1);
  });
});

describe('defaultProbeDeps', () => {
  it('returns the status code from a live endpoint', async () => {
    const url = await startServer(() => 400);
    const deps = defaultProbeDeps();

    const outcome = await probeDaemonEndpoint(url, 1_000, deps);

    expect(outcome).toEqual({ reachable: true, status: 400 });
  });

  it('classifies a closed port as refused', async () => {
    const deps = defaultProbeDeps();

    // Port 1 is privileged and unbound in test environments → ECONNREFUSED.
    const outcome = await probeDaemonEndpoint('http://127.0.0.1:1/mcp', 1_000, deps);

    expect(outcome.reachable).toBe(false);
    if (!outcome.reachable) {
      expect(outcome.reason).toBe('refused');
    }
  });
});
