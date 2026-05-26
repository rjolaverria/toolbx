import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../config/defaults.js';
import type { ToolBoxConfig } from '../../config/schema.js';
import { computeConfigIdentity } from '../identity.js';

describe('computeConfigIdentity', () => {
  it('is stable for the same config', () => {
    expect(computeConfigIdentity(DEFAULT_CONFIG)).toBe(computeConfigIdentity(DEFAULT_CONFIG));
  });

  it('ignores object key order', () => {
    const a: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      tools: { github__create_issue: { enabled: true }, jira__search: { enabled: false } },
    };
    const b: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      // Same entries, declared in the opposite order.
      tools: { jira__search: { enabled: false }, github__create_issue: { enabled: true } },
    };
    expect(computeConfigIdentity(a)).toBe(computeConfigIdentity(b));
  });

  it('changes when a tool enable flag changes', () => {
    const enabled: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      tools: { github__create_issue: { enabled: true } },
    };
    const disabled: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      tools: { github__create_issue: { enabled: false } },
    };
    expect(computeConfigIdentity(enabled)).not.toBe(computeConfigIdentity(disabled));
  });

  it('changes when the server set changes', () => {
    const withServer: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      servers: {
        github: { type: 'http', enabled: true, url: 'https://api.example.com/mcp' },
      },
    };
    expect(computeConfigIdentity(DEFAULT_CONFIG)).not.toBe(computeConfigIdentity(withServer));
  });

  it('returns a 64-char hex sha256 digest', () => {
    expect(computeConfigIdentity(DEFAULT_CONFIG)).toMatch(/^[0-9a-f]{64}$/);
  });
});
