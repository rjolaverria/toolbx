import { describe, expect, it } from 'vitest';

import {
  AUTH_EXPIRED_META_KEY,
  authExpiredMeta,
  readAuthExpiredMeta,
} from '../auth-expired-meta.js';

describe('authExpiredMeta / readAuthExpiredMeta', () => {
  it('round-trips the server name through the marker', () => {
    const meta = authExpiredMeta('jira');
    expect(meta).toEqual({ [AUTH_EXPIRED_META_KEY]: { server: 'jira' } });
    expect(readAuthExpiredMeta(meta)).toEqual({ server: 'jira' });
  });

  it('returns undefined when meta is absent', () => {
    expect(readAuthExpiredMeta(undefined)).toBeUndefined();
    expect(readAuthExpiredMeta({})).toBeUndefined();
  });

  it('returns undefined for a malformed marker', () => {
    expect(readAuthExpiredMeta({ [AUTH_EXPIRED_META_KEY]: null })).toBeUndefined();
    expect(readAuthExpiredMeta({ [AUTH_EXPIRED_META_KEY]: { server: 42 } })).toBeUndefined();
    expect(readAuthExpiredMeta({ [AUTH_EXPIRED_META_KEY]: { server: '' } })).toBeUndefined();
  });
});
