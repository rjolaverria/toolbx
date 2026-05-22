import { describe, expect, it } from 'vitest';

import { createAuthCommand } from '../index.js';

describe('createAuthCommand', () => {
  it('registers all four subcommands', () => {
    const names = createAuthCommand()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(['login', 'logout', 'refresh', 'status']);
  });
});
