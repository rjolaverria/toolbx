import type { ServerStatus, ServerStatusKind } from './types.js';

const ALLOWED_TRANSITIONS: Readonly<Record<ServerStatusKind, ReadonlySet<ServerStatusKind>>> = {
  disabled: new Set<ServerStatusKind>(['stopped']),
  stopped: new Set<ServerStatusKind>(['starting', 'disabled']),
  starting: new Set<ServerStatusKind>([
    'connected',
    'error',
    'auth_required',
    'auth_expired',
    'stopped',
    'disabled',
  ]),
  connected: new Set<ServerStatusKind>([
    'starting',
    'error',
    'auth_expired',
    'stopped',
    'disabled',
  ]),
  error: new Set<ServerStatusKind>(['starting', 'stopped', 'disabled']),
  auth_required: new Set<ServerStatusKind>(['starting', 'stopped', 'disabled']),
  auth_expired: new Set<ServerStatusKind>(['starting', 'auth_required', 'stopped', 'disabled']),
};

export class InvalidStatusTransitionError extends Error {
  override readonly name = 'InvalidStatusTransitionError';
  readonly prevKind: ServerStatusKind;
  readonly nextKind: ServerStatusKind;

  constructor(prevKind: ServerStatusKind, nextKind: ServerStatusKind) {
    super(`invalid server status transition: ${prevKind} → ${nextKind}`);
    this.prevKind = prevKind;
    this.nextKind = nextKind;
  }
}

export function isValidTransition(prevKind: ServerStatusKind, nextKind: ServerStatusKind): boolean {
  return ALLOWED_TRANSITIONS[prevKind].has(nextKind);
}

export function assertValidTransition(prev: ServerStatus, next: ServerStatus): void {
  if (!isValidTransition(prev.kind, next.kind)) {
    throw new InvalidStatusTransitionError(prev.kind, next.kind);
  }
}

export type ServerStatusEvent =
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'start_attempt'; attempt: number }
  | { type: 'connected'; at: Date }
  | { type: 'auth_required'; reason: string }
  | { type: 'auth_expired'; reason: string }
  | { type: 'failed'; error: Error; nextRetryAt: Date | null }
  | { type: 'stop' };

export type ServerStatusEventType = ServerStatusEvent['type'];

function nextStatusFor(prev: ServerStatus, event: ServerStatusEvent): ServerStatus {
  switch (event.type) {
    case 'enable':
      return { kind: 'stopped' };
    case 'disable':
      return { kind: 'disabled' };
    case 'start_attempt':
      return { kind: 'starting', attempt: event.attempt };
    case 'connected':
      return { kind: 'connected', since: event.at };
    case 'auth_required':
      return { kind: 'auth_required', reason: event.reason };
    case 'auth_expired':
      return { kind: 'auth_expired', reason: event.reason };
    case 'failed':
      return { kind: 'error', error: event.error, nextRetryAt: event.nextRetryAt };
    case 'stop':
      return { kind: 'stopped' };
  }
  // Exhaustiveness — TS will flag any unhandled event type.
  const _exhaustive: never = event;
  return _exhaustive;
}

export function transition(prev: ServerStatus, event: ServerStatusEvent): ServerStatus {
  const next = nextStatusFor(prev, event);
  assertValidTransition(prev, next);
  return next;
}
