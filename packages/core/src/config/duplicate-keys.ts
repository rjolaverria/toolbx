export interface DuplicateKey {
  key: string;
  pointer: string;
  line: number;
  column: number;
  firstSeenLine: number;
  firstSeenColumn: number;
}

export class DuplicateKeyError extends Error {
  override readonly name = 'DuplicateKeyError';
  readonly duplicates: readonly DuplicateKey[];
  readonly source: string | undefined;

  constructor(duplicates: readonly DuplicateKey[], source?: string) {
    super(formatMessage(duplicates, source));
    this.duplicates = duplicates;
    this.source = source;
  }
}

function formatMessage(duplicates: readonly DuplicateKey[], source: string | undefined): string {
  const where = source !== undefined ? ` in ${source}` : '';
  const list = duplicates
    .map(
      (d) =>
        `  - "${d.key}" at ${d.pointer} (line ${d.line}, column ${d.column}; first seen line ${d.firstSeenLine}, column ${d.firstSeenColumn})`,
    )
    .join('\n');
  return `Duplicate JSON object key${duplicates.length === 1 ? '' : 's'}${where}:\n${list}`;
}

function jsonPointerEscape(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function buildPointer(segments: readonly string[]): string {
  if (segments.length === 0) {
    return '';
  }
  return '/' + segments.map(jsonPointerEscape).join('/');
}

interface ParseState {
  source: string;
  index: number;
  line: number;
  column: number;
  duplicates: DuplicateKey[];
}

function advance(state: ParseState, n = 1): void {
  for (let k = 0; k < n && state.index < state.source.length; k++) {
    if (state.source[state.index] === '\n') {
      state.line += 1;
      state.column = 1;
    } else {
      state.column += 1;
    }
    state.index += 1;
  }
}

function skipWhitespace(state: ParseState): void {
  while (state.index < state.source.length) {
    const ch = state.source[state.index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      advance(state);
    } else {
      break;
    }
  }
}

interface StringToken {
  value: string;
  line: number;
  column: number;
}

function readString(state: ParseState): StringToken | null {
  const startLine = state.line;
  const startColumn = state.column;
  advance(state); // opening quote
  let value = '';
  while (state.index < state.source.length) {
    const ch = state.source[state.index];
    if (ch === '"') {
      advance(state);
      return { value, line: startLine, column: startColumn };
    }
    if (ch === '\\') {
      advance(state);
      const esc = state.source[state.index];
      if (esc === undefined) {
        return null;
      }
      switch (esc) {
        case '"':
        case '\\':
        case '/':
          value += esc;
          advance(state);
          break;
        case 'b':
          value += '\b';
          advance(state);
          break;
        case 'f':
          value += '\f';
          advance(state);
          break;
        case 'n':
          value += '\n';
          advance(state);
          break;
        case 'r':
          value += '\r';
          advance(state);
          break;
        case 't':
          value += '\t';
          advance(state);
          break;
        case 'u': {
          advance(state);
          const hex = state.source.slice(state.index, state.index + 4);
          if (hex.length < 4) {
            return null;
          }
          const code = parseInt(hex, 16);
          if (Number.isNaN(code)) {
            return null;
          }
          advance(state, 4);
          value += String.fromCharCode(code);
          break;
        }
        default:
          value += esc;
          advance(state);
      }
    } else {
      value += ch;
      advance(state);
    }
  }
  return null;
}

function skipPrimitive(state: ParseState): void {
  while (state.index < state.source.length) {
    const ch = state.source[state.index];
    if (
      ch === ',' ||
      ch === '}' ||
      ch === ']' ||
      ch === ' ' ||
      ch === '\t' ||
      ch === '\n' ||
      ch === '\r'
    ) {
      return;
    }
    advance(state);
  }
}

function parseValue(state: ParseState, pointer: readonly string[]): void {
  skipWhitespace(state);
  const ch = state.source[state.index];
  if (ch === '{') {
    parseObject(state, pointer);
  } else if (ch === '[') {
    parseArray(state, pointer);
  } else if (ch === '"') {
    readString(state);
  } else if (ch !== undefined) {
    skipPrimitive(state);
  }
}

function parseObject(state: ParseState, pointer: readonly string[]): void {
  advance(state); // '{'
  const seen = new Map<string, { line: number; column: number }>();
  skipWhitespace(state);
  if (state.source[state.index] === '}') {
    advance(state);
    return;
  }
  while (state.index < state.source.length) {
    skipWhitespace(state);
    if (state.source[state.index] !== '"') {
      return;
    }
    const key = readString(state);
    if (key === null) {
      return;
    }
    const existing = seen.get(key.value);
    if (existing !== undefined) {
      state.duplicates.push({
        key: key.value,
        pointer: buildPointer([...pointer, key.value]),
        line: key.line,
        column: key.column,
        firstSeenLine: existing.line,
        firstSeenColumn: existing.column,
      });
    } else {
      seen.set(key.value, { line: key.line, column: key.column });
    }
    skipWhitespace(state);
    if (state.source[state.index] !== ':') {
      return;
    }
    advance(state);
    parseValue(state, [...pointer, key.value]);
    skipWhitespace(state);
    const next = state.source[state.index];
    if (next === ',') {
      advance(state);
      continue;
    }
    if (next === '}') {
      advance(state);
      return;
    }
    return;
  }
}

function parseArray(state: ParseState, pointer: readonly string[]): void {
  advance(state); // '['
  let index = 0;
  skipWhitespace(state);
  if (state.source[state.index] === ']') {
    advance(state);
    return;
  }
  while (state.index < state.source.length) {
    parseValue(state, [...pointer, String(index)]);
    index += 1;
    skipWhitespace(state);
    const next = state.source[state.index];
    if (next === ',') {
      advance(state);
      continue;
    }
    if (next === ']') {
      advance(state);
      return;
    }
    return;
  }
}

export function findDuplicateKeys(source: string): DuplicateKey[] {
  const state: ParseState = {
    source,
    index: 0,
    line: 1,
    column: 1,
    duplicates: [],
  };
  parseValue(state, []);
  return state.duplicates;
}
