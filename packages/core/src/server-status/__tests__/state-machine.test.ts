import { describe, expect, it } from 'vitest';

import {
  assertValidTransition,
  InvalidStatusTransitionError,
  isValidTransition,
  transition,
  type ServerStatusEvent,
} from '../state-machine.js';
import type { ServerStatus, ServerStatusKind } from '../types.js';

const ALL_KINDS: readonly ServerStatusKind[] = [
  'disabled',
  'stopped',
  'starting',
  'connected',
  'auth_required',
  'auth_expired',
  'error',
];

const ALLOWED: Record<ServerStatusKind, ReadonlySet<ServerStatusKind>> = {
  disabled: new Set(['stopped']),
  stopped: new Set(['starting', 'disabled']),
  starting: new Set(['connected', 'error', 'auth_required', 'auth_expired', 'stopped', 'disabled']),
  connected: new Set(['starting', 'error', 'auth_expired', 'stopped', 'disabled']),
  error: new Set(['starting', 'stopped', 'disabled']),
  auth_required: new Set(['starting', 'stopped', 'disabled']),
  auth_expired: new Set(['starting', 'auth_required', 'stopped', 'disabled']),
};

function exemplar(kind: ServerStatusKind): ServerStatus {
  switch (kind) {
    case 'disabled':
      return { kind: 'disabled' };
    case 'stopped':
      return { kind: 'stopped' };
    case 'starting':
      return { kind: 'starting', attempt: 1 };
    case 'connected':
      return { kind: 'connected', since: new Date('2026-01-01T00:00:00.000Z') };
    case 'auth_required':
      return { kind: 'auth_required', reason: 'token missing' };
    case 'auth_expired':
      return { kind: 'auth_expired', reason: 'token expired' };
    case 'error':
      return { kind: 'error', error: new Error('boom'), nextRetryAt: null };
  }
}

describe('isValidTransition / assertValidTransition', () => {
  it('matches the allowed-transitions table for every prev × next pair', () => {
    for (const prevKind of ALL_KINDS) {
      for (const nextKind of ALL_KINDS) {
        const allowed = ALLOWED[prevKind].has(nextKind);
        expect(isValidTransition(prevKind, nextKind)).toBe(allowed);
      }
    }
  });

  it('rejects every self-loop (e.g. connected → connected)', () => {
    for (const kind of ALL_KINDS) {
      expect(isValidTransition(kind, kind)).toBe(false);
    }
  });

  it('rejects the example invalid transition disabled → connected with a typed error', () => {
    expect(() => assertValidTransition(exemplar('disabled'), exemplar('connected'))).toThrow(
      InvalidStatusTransitionError,
    );
    try {
      assertValidTransition(exemplar('disabled'), exemplar('connected'));
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStatusTransitionError);
      const e = err as InvalidStatusTransitionError;
      expect(e.prevKind).toBe('disabled');
      expect(e.nextKind).toBe('connected');
      expect(e.message).toContain('disabled');
      expect(e.message).toContain('connected');
    }
  });

  it('returns void on a valid transition (stopped → starting)', () => {
    expect(() => assertValidTransition(exemplar('stopped'), exemplar('starting'))).not.toThrow();
  });
});

describe('transition reducer', () => {
  const at = new Date('2026-04-29T10:00:00.000Z');
  const retryAt = new Date('2026-04-29T10:00:05.000Z');
  const err = new Error('connection refused');

  it('enable: disabled → stopped', () => {
    expect(transition(exemplar('disabled'), { type: 'enable' })).toEqual({ kind: 'stopped' });
  });

  it('enable: rejected from non-disabled', () => {
    expect(() => transition(exemplar('stopped'), { type: 'enable' })).toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('disable: works from every non-disabled state', () => {
    for (const kind of ALL_KINDS) {
      if (kind === 'disabled') {
        expect(() => transition(exemplar(kind), { type: 'disable' })).toThrow(
          InvalidStatusTransitionError,
        );
        continue;
      }
      expect(transition(exemplar(kind), { type: 'disable' })).toEqual({ kind: 'disabled' });
    }
  });

  it('start_attempt: stopped/error/auth_required/auth_expired/connected → starting', () => {
    const allowedFrom: ServerStatusKind[] = [
      'stopped',
      'error',
      'auth_required',
      'auth_expired',
      'connected',
    ];
    for (const kind of allowedFrom) {
      expect(transition(exemplar(kind), { type: 'start_attempt', attempt: 3 })).toEqual({
        kind: 'starting',
        attempt: 3,
      });
    }
    // disabled and starting cannot launch a new attempt.
    expect(() => transition(exemplar('disabled'), { type: 'start_attempt', attempt: 1 })).toThrow(
      InvalidStatusTransitionError,
    );
    expect(() => transition(exemplar('starting'), { type: 'start_attempt', attempt: 2 })).toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('connected: only valid from starting', () => {
    expect(transition(exemplar('starting'), { type: 'connected', at })).toEqual({
      kind: 'connected',
      since: at,
    });
    for (const kind of ALL_KINDS) {
      if (kind === 'starting') {
        continue;
      }
      expect(() => transition(exemplar(kind), { type: 'connected', at })).toThrow(
        InvalidStatusTransitionError,
      );
    }
  });

  it('auth_required: valid from starting and auth_expired', () => {
    expect(
      transition(exemplar('starting'), { type: 'auth_required', reason: 'missing token' }),
    ).toEqual({ kind: 'auth_required', reason: 'missing token' });
    expect(
      transition(exemplar('auth_expired'), { type: 'auth_required', reason: 'refresh failed' }),
    ).toEqual({ kind: 'auth_required', reason: 'refresh failed' });
    expect(() => transition(exemplar('connected'), { type: 'auth_required', reason: 'x' })).toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('auth_expired: valid from starting and connected', () => {
    expect(
      transition(exemplar('connected'), { type: 'auth_expired', reason: 'token expired' }),
    ).toEqual({ kind: 'auth_expired', reason: 'token expired' });
    expect(
      transition(exemplar('starting'), { type: 'auth_expired', reason: 'token expired' }),
    ).toEqual({ kind: 'auth_expired', reason: 'token expired' });
    expect(() => transition(exemplar('error'), { type: 'auth_expired', reason: 'x' })).toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('failed: valid from starting and connected', () => {
    expect(
      transition(exemplar('starting'), { type: 'failed', error: err, nextRetryAt: retryAt }),
    ).toEqual({ kind: 'error', error: err, nextRetryAt: retryAt });
    expect(
      transition(exemplar('connected'), { type: 'failed', error: err, nextRetryAt: null }),
    ).toEqual({ kind: 'error', error: err, nextRetryAt: null });
    expect(() =>
      transition(exemplar('error'), { type: 'failed', error: err, nextRetryAt: null }),
    ).toThrow(InvalidStatusTransitionError);
  });

  it('stop: valid from every state except stopped (self-loop)', () => {
    for (const kind of ALL_KINDS) {
      if (kind === 'stopped') {
        expect(() => transition(exemplar(kind), { type: 'stop' })).toThrow(
          InvalidStatusTransitionError,
        );
        continue;
      }
      expect(transition(exemplar(kind), { type: 'stop' })).toEqual({ kind: 'stopped' });
    }
  });

  it('exhaustively rejects illegal (prevKind, eventType) pairs without losing typing', () => {
    const events: readonly ServerStatusEvent[] = [
      { type: 'enable' },
      { type: 'start_attempt', attempt: 1 },
      { type: 'connected', at },
      { type: 'auth_required', reason: 'r' },
      { type: 'auth_expired', reason: 'r' },
      { type: 'failed', error: err, nextRetryAt: null },
    ];
    // For each event, picking a state where the event is invalid yields the typed error.
    for (const event of events) {
      let threw = false;
      for (const kind of ALL_KINDS) {
        try {
          transition(exemplar(kind), event);
        } catch (e) {
          if (e instanceof InvalidStatusTransitionError) {
            threw = true;
            break;
          }
        }
      }
      expect(threw).toBe(true);
    }
  });
});
