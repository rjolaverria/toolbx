import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createNoopLogger } from '@toolbx/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createToolsChangedNotifier,
  type ToolsChangedNotifierScheduler,
} from '../notify-tools-changed.js';
import { createDownstreamSession } from '../session.js';

interface FakeScheduler extends ToolsChangedNotifierScheduler {
  pending(): number;
  fireAll(): void;
}

function fakeScheduler(): FakeScheduler {
  const queue: Array<() => void> = [];
  return {
    setTimeout(handler) {
      queue.push(handler);
      return queue.length - 1;
    },
    clearTimeout(handle) {
      const index = handle as number;
      if (index >= 0 && index < queue.length) {
        queue[index] = noop;
      }
    },
    pending() {
      return queue.filter((fn) => fn !== noop).length;
    },
    fireAll() {
      while (queue.length > 0) {
        const fn = queue.shift();
        if (fn && fn !== noop) {
          fn();
        }
      }
    },
  };
}

function noop(): void {
  // Replacement for cleared timer slots; intentionally empty.
}

function makeFakeServer(): {
  server: Server;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  const sendSpy = vi.fn(() => Promise.resolve());
  const server = { sendToolListChanged: sendSpy } as unknown as Server;
  return { server, sendSpy };
}

describe('createToolsChangedNotifier', () => {
  it('coalesces multiple schedule() calls inside a debounce window into one send', () => {
    const scheduler = fakeScheduler();
    const { server, sendSpy } = makeFakeServer();
    const session = createDownstreamSession('session-1');
    session.ready = true;
    const notifier = createToolsChangedNotifier({ server, session, scheduler });

    notifier.schedule();
    notifier.schedule();
    notifier.schedule();

    expect(scheduler.pending()).toBe(1);
    expect(sendSpy).not.toHaveBeenCalled();

    scheduler.fireAll();

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh debounce window after the previous timer fires', () => {
    const scheduler = fakeScheduler();
    const { server, sendSpy } = makeFakeServer();
    const session = createDownstreamSession('session-2');
    session.ready = true;
    const notifier = createToolsChangedNotifier({ server, session, scheduler });

    notifier.schedule();
    scheduler.fireAll();
    expect(sendSpy).toHaveBeenCalledTimes(1);

    notifier.schedule();
    notifier.schedule();
    expect(scheduler.pending()).toBe(1);
    scheduler.fireAll();

    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('does not send when the session has not yet received notifications/initialized', () => {
    const scheduler = fakeScheduler();
    const { server, sendSpy } = makeFakeServer();
    const session = createDownstreamSession('session-3');
    const notifier = createToolsChangedNotifier({ server, session, scheduler });

    notifier.schedule();
    scheduler.fireAll();

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('drops scheduled sends after dispose()', () => {
    const scheduler = fakeScheduler();
    const { server, sendSpy } = makeFakeServer();
    const session = createDownstreamSession('session-4');
    session.ready = true;
    const notifier = createToolsChangedNotifier({ server, session, scheduler });

    notifier.schedule();
    expect(scheduler.pending()).toBe(1);
    notifier.dispose();

    scheduler.fireAll();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('ignores schedule() calls after dispose()', () => {
    const scheduler = fakeScheduler();
    const { server, sendSpy } = makeFakeServer();
    const session = createDownstreamSession('session-5');
    session.ready = true;
    const notifier = createToolsChangedNotifier({ server, session, scheduler });

    notifier.dispose();
    notifier.schedule();
    scheduler.fireAll();

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('logs (but does not throw) if sendToolListChanged rejects', async () => {
    const scheduler = fakeScheduler();
    const sendSpy = vi.fn(() => Promise.reject(new Error('transport gone')));
    const server = { sendToolListChanged: sendSpy } as unknown as Server;
    const session = createDownstreamSession('session-6');
    session.ready = true;
    const baseLogger = createNoopLogger();
    const warn = vi.spyOn(baseLogger, 'warn');
    const notifier = createToolsChangedNotifier({
      server,
      session,
      scheduler,
      logger: baseLogger,
    });

    notifier.schedule();
    scheduler.fireAll();
    // Allow the rejected promise to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
