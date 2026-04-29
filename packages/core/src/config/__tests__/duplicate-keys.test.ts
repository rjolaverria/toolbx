import { describe, expect, it } from 'vitest';

import { findDuplicateKeys } from '../duplicate-keys.js';

describe('findDuplicateKeys', () => {
  it('returns an empty array when there are no duplicates', () => {
    const json = '{"a":1,"b":2,"c":{"d":3}}';
    expect(findDuplicateKeys(json)).toEqual([]);
  });

  it('detects duplicate server names under `servers`', () => {
    const json = `{
  "servers": {
    "jira": { "type": "http" },
    "jira": { "type": "stdio" }
  }
}`;
    const duplicates = findDuplicateKeys(json);
    expect(duplicates).toHaveLength(1);
    const dup = duplicates[0];
    expect(dup).toBeDefined();
    if (dup === undefined) {
      return;
    }
    expect(dup.key).toBe('jira');
    expect(dup.pointer).toBe('/servers/jira');
    expect(dup.line).toBe(4);
    expect(dup.column).toBe(5);
    expect(dup.firstSeenLine).toBe(3);
    expect(dup.firstSeenColumn).toBe(5);
  });

  it('detects multiple duplicates in different objects', () => {
    const json = '{"a":{"x":1,"x":2},"b":{"y":1,"y":2,"y":3}}';
    const duplicates = findDuplicateKeys(json);
    expect(duplicates).toHaveLength(3);
    expect(duplicates.map((d) => d.pointer)).toEqual(['/a/x', '/b/y', '/b/y']);
  });

  it('reports correct pointer for duplicates inside an array element', () => {
    const json = '{"servers":[{"name":"a","name":"b"}]}';
    const duplicates = findDuplicateKeys(json);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.pointer).toBe('/servers/0/name');
  });

  it('does not flag identical string values', () => {
    const json = '{"a":"a","b":"a","c":"a"}';
    expect(findDuplicateKeys(json)).toEqual([]);
  });

  it('handles escaped quotes in keys', () => {
    const json = '{"a\\"b":1,"a\\"b":2}';
    const duplicates = findDuplicateKeys(json);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.key).toBe('a"b');
  });

  it('escapes JSON Pointer reserved characters in pointer segments', () => {
    const json = '{"a/b":{"c~d":1,"c~d":2}}';
    const duplicates = findDuplicateKeys(json);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.pointer).toBe('/a~1b/c~0d');
  });

  it('reports 1-based line/column at the duplicate occurrence', () => {
    const json = '{\n  "x": 1,\n  "x": 2\n}';
    const duplicates = findDuplicateKeys(json);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.line).toBe(3);
    expect(duplicates[0]?.column).toBe(3);
  });
});
