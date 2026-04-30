import { describe, expect, it } from 'vitest';

import { probeServer } from '../server-probe.js';

describe('probeServer', () => {
  it('short-circuits to disabled without spawning a client', async () => {
    const result = await probeServer('github', {
      type: 'stdio',
      enabled: false,
      command: 'true',
      args: [],
    });

    expect(result).toEqual({ kind: 'disabled' });
  });
});
