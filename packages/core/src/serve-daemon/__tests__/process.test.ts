import { describe, expect, it, vi } from 'vitest';

import { isProcessAlive } from '../process.js';

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a pid that does not exist', () => {
    // Pick a pid far above the typical Linux maximum (kernel default ~4M).
    expect(isProcessAlive(2 ** 31 - 1)).toBe(false);
  });

  it('returns false for invalid pids', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });

  it('treats EPERM as alive (process exists, we just cannot signal it)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    try {
      expect(isProcessAlive(42)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('treats ESRCH as dead', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    try {
      expect(isProcessAlive(42)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
