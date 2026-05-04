import { describe, expect, it, vi } from 'vitest';

import { createDownstreamSession } from '../session.js';

describe('createDownstreamSession', () => {
  it('starts in the not-ready state and accepts an explicit flip', () => {
    const session = createDownstreamSession('s1');
    expect(session.id).toBe('s1');
    expect(session.ready).toBe(false);
    session.ready = true;
    expect(session.ready).toBe(true);
  });

  it('fans runCloseCallbacks() to every registered onClose listener', () => {
    const session = createDownstreamSession('s2');
    const a = vi.fn();
    const b = vi.fn();
    session.onClose(a);
    session.onClose(b);

    session.runCloseCallbacks();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('clears registered callbacks after runCloseCallbacks() so a second close is a no-op', () => {
    const session = createDownstreamSession('s3');
    const cb = vi.fn();
    session.onClose(cb);

    session.runCloseCallbacks();
    session.runCloseCallbacks();

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returns an unregister function that prevents the listener from firing', () => {
    const session = createDownstreamSession('s4');
    const cb = vi.fn();
    const off = session.onClose(cb);
    off();

    session.runCloseCallbacks();

    expect(cb).not.toHaveBeenCalled();
  });

  it('isolates one listener throwing from the others', () => {
    const session = createDownstreamSession('s5');
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    session.onClose(a);
    session.onClose(b);

    expect(() => session.runCloseCallbacks()).not.toThrow();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
