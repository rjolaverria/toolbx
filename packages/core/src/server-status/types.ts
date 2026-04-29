export type ServerStatus =
  | { kind: 'disabled' }
  | { kind: 'starting'; attempt: number }
  | { kind: 'connected'; since: Date }
  | { kind: 'auth_required'; reason: string }
  | { kind: 'auth_expired'; reason: string }
  | { kind: 'error'; error: Error; nextRetryAt: Date | null }
  | { kind: 'stopped' };

export type ServerStatusKind = ServerStatus['kind'];
