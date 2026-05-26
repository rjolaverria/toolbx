export type ServerStatus =
  | { kind: 'disabled' }
  | { kind: 'starting'; attempt: number }
  | { kind: 'connected'; since: Date }
  // `tokenEnv` names the bearer token environment variable the daemon needs at
  // startup; it is the authoritative signal that this `auth_required` is a
  // missing-bearer-env case (recovered by restarting the daemon) rather than a
  // missing-OAuth-token case (recovered by `tlbx auth login`). Absent for OAuth.
  | { kind: 'auth_required'; reason: string; tokenEnv?: string }
  | { kind: 'auth_expired'; reason: string }
  | { kind: 'error'; error: Error; nextRetryAt: Date | null }
  | { kind: 'stopped' };

export type ServerStatusKind = ServerStatus['kind'];
