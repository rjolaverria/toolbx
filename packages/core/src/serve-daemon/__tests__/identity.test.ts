import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../config/defaults.js';
import type { ToolbxConfig } from '../../config/schema.js';
import { computeConfigIdentity } from '../identity.js';

describe('computeConfigIdentity', () => {
  it('is stable for the same config', () => {
    expect(computeConfigIdentity(DEFAULT_CONFIG)).toBe(computeConfigIdentity(DEFAULT_CONFIG));
  });

  it('ignores object key order', () => {
    const a: ToolbxConfig = {
      ...DEFAULT_CONFIG,
      tools: { github__create_issue: { enabled: true }, jira__search: { enabled: false } },
    };
    const b: ToolbxConfig = {
      ...DEFAULT_CONFIG,
      // Same entries, declared in the opposite order.
      tools: { jira__search: { enabled: false }, github__create_issue: { enabled: true } },
    };
    expect(computeConfigIdentity(a)).toBe(computeConfigIdentity(b));
  });

  it('changes when a tool enable flag changes', () => {
    const enabled: ToolbxConfig = {
      ...DEFAULT_CONFIG,
      tools: { github__create_issue: { enabled: true } },
    };
    const disabled: ToolbxConfig = {
      ...DEFAULT_CONFIG,
      tools: { github__create_issue: { enabled: false } },
    };
    expect(computeConfigIdentity(enabled)).not.toBe(computeConfigIdentity(disabled));
  });

  it('changes when the server set changes', () => {
    const withServer: ToolbxConfig = {
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

  it('is unchanged by an empty or omitted custom-tool manifest', () => {
    const base = computeConfigIdentity(DEFAULT_CONFIG);
    expect(computeConfigIdentity(DEFAULT_CONFIG, [])).toBe(base);
    expect(computeConfigIdentity(DEFAULT_CONFIG, undefined)).toBe(base);
  });

  it('changes when the custom-tool manifest changes (enable/disable/remove)', () => {
    const tool = {
      name: 'echo',
      namespace: 'personal',
      exposedName: 'personal__echo',
      title: 'Echo',
      description: 'Echo',
      entry: 'tools/personal/echo.ts',
      runtime: 'node',
      enabled: true,
      timeoutMs: 30_000,
      permissions: { network: false, filesystem: false, env: [] },
    };
    const enabled = computeConfigIdentity(DEFAULT_CONFIG, [tool]);
    const disabled = computeConfigIdentity(DEFAULT_CONFIG, [{ ...tool, enabled: false }]);
    const removed = computeConfigIdentity(DEFAULT_CONFIG, []);
    expect(enabled).not.toBe(disabled);
    expect(enabled).not.toBe(removed);
    expect(disabled).not.toBe(removed);
  });
});
