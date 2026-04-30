import { describe, expect, it } from 'vitest';

import { parsePositiveInt, withTimeout } from '../server-shared.js';

describe('parsePositiveInt', () => {
  it('accepts plain positive integer strings', () => {
    expect(parsePositiveInt('5000')).toBe(5000);
    expect(parsePositiveInt('  42  ')).toBe(42);
  });

  it('rejects suffixes like "5s" instead of silently truncating', () => {
    expect(() => parsePositiveInt('5s')).toThrow();
    expect(() => parsePositiveInt('1000ms')).toThrow();
  });

  it('rejects zero, negatives, decimals, and non-numeric input', () => {
    expect(() => parsePositiveInt('0')).toThrow();
    expect(() => parsePositiveInt('-1')).toThrow();
    expect(() => parsePositiveInt('1.5')).toThrow();
    expect(() => parsePositiveInt('abc')).toThrow();
    expect(() => parsePositiveInt('')).toThrow();
  });
});

describe('withTimeout', () => {
  it('resolves with the inner promise when it settles before the timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(result).toBe('ok');
  });

  it('rejects with a labeled error when the inner promise stalls', async () => {
    const stalled = new Promise<never>(() => {
      // never settles
    });
    await expect(withTimeout(stalled, 10, 'listTools')).rejects.toThrow(
      'listTools timed out after 10ms',
    );
  });

  it('propagates the inner promise rejection as-is', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'test')).rejects.toThrow(
      'boom',
    );
  });
});
