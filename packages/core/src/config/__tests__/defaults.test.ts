import { describe, expect, it } from 'vitest';

import { CONFIG_SCHEMA_URL, DEFAULT_CONFIG, DEFAULT_NAMESPACE_SEPARATOR } from '../defaults.js';
import { ToolboxConfigSchema } from '../schema.js';

describe('DEFAULT_CONFIG', () => {
  it('parses cleanly through ToolboxConfigSchema', () => {
    const result = ToolboxConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  it('is frozen at the top level', () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  });

  it('lists $schema first to anchor JSON serialization order', () => {
    const keys = Object.keys(DEFAULT_CONFIG);
    expect(keys[0]).toBe('$schema');
  });

  it('uses the canonical namespace separator', () => {
    expect(DEFAULT_NAMESPACE_SEPARATOR).toBe('__');
    expect(DEFAULT_CONFIG.namespacing.separator).toBe('__');
  });

  it('exposes the documented schema URL', () => {
    expect(CONFIG_SCHEMA_URL).toBe('https://toolbox.dev/schema/config.schema.json');
  });
});
