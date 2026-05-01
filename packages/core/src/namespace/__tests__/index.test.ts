import { describe, expect, it } from 'vitest';

import {
  detectCollisions,
  formatExposedName,
  parseExposedName,
  UnsupportedNamespacingOptionError,
  type NamespaceOptions,
} from '../index.js';

const OPTS: NamespaceOptions = { separator: '__', format: 'server__tool' };

describe('formatExposedName', () => {
  it.each([
    ['jira', 'search_issues', 'jira__search_issues'],
    ['github', 'create_pull_request', 'github__create_pull_request'],
    ['my-server', 'do_thing', 'my-server__do_thing'],
    ['srv', 'tool__with__underscores', 'srv__tool__with__underscores'],
  ])('joins %s + %s as %s', (server, upstream, expected) => {
    expect(formatExposedName(server, upstream, OPTS)).toBe(expected);
  });

  it('throws on an unsupported separator (defense-in-depth for callers bypassing the schema)', () => {
    expect(() =>
      formatExposedName('s', 't', {
        separator: '::' as unknown as NamespaceOptions['separator'],
        format: 'server__tool',
      }),
    ).toThrow(UnsupportedNamespacingOptionError);
  });

  it('throws on an unsupported format', () => {
    expect(() =>
      formatExposedName('s', 't', {
        separator: '__',
        format: 'tool__server' as unknown as NamespaceOptions['format'],
      }),
    ).toThrow(UnsupportedNamespacingOptionError);
  });
});

describe('parseExposedName', () => {
  it('returns the server / upstream pair', () => {
    expect(parseExposedName('jira__search_issues', OPTS)).toEqual({
      serverName: 'jira',
      upstreamName: 'search_issues',
    });
  });

  it('splits on the first separator so upstream names with `__` round-trip', () => {
    expect(parseExposedName('srv__tool__with__underscores', OPTS)).toEqual({
      serverName: 'srv',
      upstreamName: 'tool__with__underscores',
    });
  });

  it('returns null when the separator is missing', () => {
    expect(parseExposedName('no_separator_here', OPTS)).toBeNull();
  });

  it('returns null when the server segment is empty', () => {
    expect(parseExposedName('__just_tool', OPTS)).toBeNull();
  });

  it('returns null when the upstream segment is empty', () => {
    expect(parseExposedName('server__', OPTS)).toBeNull();
  });

  it.each([
    ['jira', 'search_issues'],
    ['github', 'create_pull_request'],
    ['my-server', 'do__thing'],
    ['srv', 't'],
    ['s', 'tool__with__underscores'],
  ])('round-trips %s + %s', (server, upstream) => {
    const formatted = formatExposedName(server, upstream, OPTS);
    expect(parseExposedName(formatted, OPTS)).toEqual({
      serverName: server,
      upstreamName: upstream,
    });
  });
});

describe('detectCollisions', () => {
  it('returns [] when no two servers expose the same name', () => {
    expect(
      detectCollisions(
        {
          jira: ['search_issues', 'create_issue'],
          github: ['create_pull_request'],
        },
        OPTS,
      ),
    ).toEqual([]);
  });

  it('does not report a collision when two distinct servers expose tools with the same upstream name', () => {
    // Distinct (serverName, upstreamName) pairs format to distinct exposed
    // names under the `server__tool` format, so there is no conflict.
    expect(
      detectCollisions(
        {
          jira: ['search_issues'],
          github: ['search_issues'],
        },
        OPTS,
      ),
    ).toEqual([]);
  });

  it('groups by exposedName when callers seed duplicate (server, upstream) pairs', () => {
    const collisions = detectCollisions(
      {
        jira: ['search_issues', 'search_issues'],
      },
      OPTS,
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.exposedName).toBe('jira__search_issues');
    expect(collisions[0]?.sources).toHaveLength(2);
  });

  it('sorts collisions by exposed name', () => {
    const collisions = detectCollisions(
      {
        zeta: ['t', 't'],
        alpha: ['t', 't'],
      },
      OPTS,
    );
    expect(collisions.map((c) => c.exposedName)).toEqual(['alpha__t', 'zeta__t']);
  });
});
