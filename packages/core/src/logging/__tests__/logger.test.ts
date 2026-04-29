import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger, createNoopLogger } from '../logger.js';

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[`);

class Sink extends Writable {
  readonly chunks: Buffer[] = [];

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    cb();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  lines(): string[] {
    return this.text().split('\n').filter(Boolean);
  }

  jsonLines(): Record<string, unknown>[] {
    return this.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

const originalIsTty = process.stdout.isTTY;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalIsTty,
    configurable: true,
    writable: true,
  });
});

function setStdoutTty(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('createLogger (json mode)', () => {
  beforeEach(() => {
    setStdoutTty(false);
  });

  it('emits one JSON object per line with time, level, and msg', () => {
    const sink = new Sink();
    const logger = createLogger({ destination: sink, format: 'json' });

    logger.info('hello');
    logger.warn('careful');

    const records = sink.jsonLines();
    expect(records).toHaveLength(2);
    const [first, second] = records;
    expect(first).toMatchObject({ msg: 'hello' });
    expect(second).toMatchObject({ msg: 'careful' });
    for (const record of records) {
      expect(typeof record['time']).toBe('string');
      expect(record['time']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(typeof record['level']).toBe('number');
    }
  });

  it('does not include pid or hostname when no bindings are provided', () => {
    const sink = new Sink();
    const logger = createLogger({ destination: sink, format: 'json' });

    logger.info('no metadata');

    const [record] = sink.jsonLines();
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty('pid');
    expect(record).not.toHaveProperty('hostname');
  });

  it('includes base bindings on every line', () => {
    const sink = new Sink();
    const logger = createLogger({
      destination: sink,
      format: 'json',
      bindings: { server: 'jira' },
    });

    logger.info('first');
    logger.info('second');

    for (const record of sink.jsonLines()) {
      expect(record['server']).toBe('jira');
    }
  });
});

describe('createLogger (level filtering)', () => {
  beforeEach(() => {
    setStdoutTty(false);
  });

  it('drops debug and trace at level info (default)', () => {
    const sink = new Sink();
    const logger = createLogger({ destination: sink, format: 'json' });

    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    const messages = sink.jsonLines().map((r) => r['msg']);
    expect(messages).toEqual(['i', 'w', 'e']);
  });

  it('drops info at level warn', () => {
    const sink = new Sink();
    const logger = createLogger({ destination: sink, format: 'json', level: 'warn' });

    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(sink.jsonLines().map((r) => r['msg'])).toEqual(['w', 'e']);
  });

  it('drops everything at level silent', () => {
    const sink = new Sink();
    const logger = createLogger({ destination: sink, format: 'json', level: 'silent' });

    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');

    expect(sink.jsonLines()).toHaveLength(0);
  });
});

describe('createLogger (child bindings)', () => {
  beforeEach(() => {
    setStdoutTty(false);
  });

  it('merges parent and child bindings', () => {
    const sink = new Sink();
    const parent = createLogger({
      destination: sink,
      format: 'json',
      bindings: { server: 'jira' },
    });
    const child = parent.child({ reqId: 42 });

    child.info('hi');

    const [record] = sink.jsonLines();
    expect(record).toMatchObject({ server: 'jira', reqId: 42, msg: 'hi' });
  });

  it('child bindings shadow parent bindings on key collision', () => {
    const sink = new Sink();
    const parent = createLogger({
      destination: sink,
      format: 'json',
      bindings: { server: 'jira' },
    });
    const child = parent.child({ server: 'github' });

    child.info('hi');

    const [record] = sink.jsonLines();
    expect(record?.['server']).toBe('github');
  });

  it('child writes to the same destination as the parent', () => {
    const sink = new Sink();
    const parent = createLogger({ destination: sink, format: 'json' });
    const child = parent.child({ scope: 'inner' });

    parent.info('p');
    child.info('c');

    expect(sink.jsonLines()).toHaveLength(2);
  });
});

describe('createLogger (destination)', () => {
  beforeEach(() => {
    setStdoutTty(false);
  });

  it("writes to process.stderr when destination is 'stderr'", () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const logger = createLogger({ destination: 'stderr', format: 'json' });
    logger.info('hi');

    expect(stderrWrite).toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("writes to process.stdout when destination is 'stdout'", () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const logger = createLogger({ destination: 'stdout', format: 'json' });
    logger.info('hi');

    expect(stdoutWrite).toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('defaults to stderr', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const logger = createLogger({ format: 'json' });
    logger.info('hi');

    expect(stderrWrite).toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('writes raw bytes to a custom Writable', () => {
    const sink = new Sink();
    const logger = createLogger({ destination: sink, format: 'json' });

    logger.info('hi');

    expect(sink.text()).toContain('"msg":"hi"');
  });
});

describe('createLogger (pretty mode + ANSI gating)', () => {
  it('emits no ANSI escapes when process.stdout.isTTY is false', () => {
    setStdoutTty(false);
    const sink = new Sink();
    const logger = createLogger({ destination: sink, format: 'pretty' });

    logger.info('hello there');

    const text = sink.text();
    expect(text).toContain('hello there');
    expect(text).toContain('INFO');
    expect(text).not.toMatch(ANSI_ESCAPE);
  });

  it('emits ANSI escapes when process.stdout.isTTY is true', () => {
    setStdoutTty(true);
    const sink = new Sink();
    const logger = createLogger({ destination: sink, format: 'pretty' });

    logger.info('colorful');

    expect(sink.text()).toMatch(ANSI_ESCAPE);
  });

  it('chooses pretty automatically when stdout is a TTY', () => {
    setStdoutTty(true);
    const sink = new Sink();
    const logger = createLogger({ destination: sink });

    logger.info('auto');

    expect(sink.text()).toContain('auto');
    expect(sink.text()).not.toContain('"msg":"auto"');
  });

  it('chooses json automatically when stdout is not a TTY', () => {
    setStdoutTty(false);
    const sink = new Sink();
    const logger = createLogger({ destination: sink });

    logger.info('auto');

    expect(sink.text()).toContain('"msg":"auto"');
  });
});

describe('createNoopLogger', () => {
  it('does not write to stderr or stdout', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const logger = createNoopLogger();
    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');

    const child = logger.child({ scope: 'x' });
    child.info('nope');

    expect(stderrWrite).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
