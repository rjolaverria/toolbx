import { describe, expect, it } from 'vitest';

import { redactSecrets } from '../redact.js';

describe('redactSecrets', () => {
  it('replaces every occurrence of each secret value with ***', () => {
    const out = redactSecrets('token=abc123 again abc123', ['abc123']);
    expect(out).toBe('token=*** again ***');
  });

  it('ignores empty and whitespace-only values to avoid mangling all text', () => {
    expect(redactSecrets('hello world', ['', '   '])).toBe('hello world');
  });

  it('redacts multiple distinct secrets', () => {
    expect(redactSecrets('a=AAA b=BBB', ['AAA', 'BBB'])).toBe('a=*** b=***');
  });

  it('returns the input unchanged when there are no secrets', () => {
    expect(redactSecrets('nothing to hide', [])).toBe('nothing to hide');
  });
});
