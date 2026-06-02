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

  it('redacts a longer secret fully even when a shorter secret is a prefix', () => {
    expect(redactSecrets('token=abc123', ['abc', 'abc123'])).toBe('token=***');
  });

  it('redacts both overlapping secrets across the string', () => {
    expect(redactSecrets('x abc123 y abc z', ['abc', 'abc123'])).toBe('x *** y *** z');
  });

  it('dedupes repeated secret values', () => {
    expect(redactSecrets('a=SECRET b=SECRET', ['SECRET', 'SECRET'])).toBe('a=*** b=***');
  });
});
