import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetGlobalVisibilityForTests,
  createSessionVisibility,
  type SessionVisibilityChangeReason,
} from '../session-visibility.js';

const BOOTSTRAP = [
  'toolbox__search_tools',
  'toolbox__reveal_tools',
  'toolbox__hide_tools',
  'toolbox__list_available_servers',
  'toolbox__list_revealed_tools',
] as const;

beforeEach(() => {
  __resetGlobalVisibilityForTests();
});

afterEach(() => {
  __resetGlobalVisibilityForTests();
});

describe('createSessionVisibility — initial state', () => {
  it('starts with an empty revealed set in session mode', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    expect(v.list()).toEqual([]);
    expect(v.isVisible('jira__search_issues')).toBe(false);
  });

  it('snapshot() returns bootstrap tools sorted by byte order', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    expect(v.snapshot()).toEqual([...BOOTSTRAP].sort());
  });

  it('treats bootstrap tools as visible regardless of state', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    for (const name of BOOTSTRAP) {
      expect(v.isVisible(name)).toBe(true);
    }
  });

  it('omitting bootstrapToolNames is allowed (bootstrap disabled)', () => {
    const v = createSessionVisibility({ mode: 'session' });
    expect(v.isVisible('toolbox__search_tools')).toBe(false);
    expect(v.snapshot()).toEqual([]);
  });
});

describe('createSessionVisibility — reveal', () => {
  it('reveals a tool, exposes it via list/isVisible, and emits one change', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    const events: SessionVisibilityChangeReason[] = [];
    v.on('change', (e) => events.push(e));

    const added = v.reveal(['jira__search_issues']);

    expect(added).toEqual(['jira__search_issues']);
    expect(v.list()).toEqual(['jira__search_issues']);
    expect(v.isVisible('jira__search_issues')).toBe(true);
    expect(events).toEqual([{ kind: 'reveal', added: ['jira__search_issues'] }]);
  });

  it('revealing an already-visible tool is a no-op and emits no event', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    v.reveal(['jira__search_issues']);

    const listener = vi.fn();
    v.on('change', listener);

    const added = v.reveal(['jira__search_issues']);

    expect(added).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('revealing a bootstrap tool is a no-op (already visible) with no event', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    const listener = vi.fn();
    v.on('change', listener);

    const added = v.reveal(['toolbox__search_tools']);

    expect(added).toEqual([]);
    expect(v.list()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('mixes new and existing names: only new ones are returned and reported', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    v.reveal(['jira__search_issues']);

    const events: SessionVisibilityChangeReason[] = [];
    v.on('change', (e) => events.push(e));

    const added = v.reveal([
      'jira__search_issues', // already revealed
      'github__create_issue', // new
      'toolbox__search_tools', // bootstrap → skip
      'github__create_issue', // duplicate within batch
    ]);

    expect(added).toEqual(['github__create_issue']);
    expect(events).toEqual([{ kind: 'reveal', added: ['github__create_issue'] }]);
    expect(v.list()).toEqual(['github__create_issue', 'jira__search_issues']);
  });
});

describe('createSessionVisibility — hide', () => {
  it('hides a previously revealed tool and emits one change', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    v.reveal(['jira__search_issues']);

    const events: SessionVisibilityChangeReason[] = [];
    v.on('change', (e) => events.push(e));

    const removed = v.hide(['jira__search_issues']);

    expect(removed).toEqual(['jira__search_issues']);
    expect(v.list()).toEqual([]);
    expect(v.isVisible('jira__search_issues')).toBe(false);
    expect(events).toEqual([{ kind: 'hide', removed: ['jira__search_issues'] }]);
  });

  it('hiding a tool that is not revealed is a no-op with no event', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    const listener = vi.fn();
    v.on('change', listener);

    const removed = v.hide(['jira__search_issues']);

    expect(removed).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('cannot hide bootstrap tools — they remain visible', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    const listener = vi.fn();
    v.on('change', listener);

    const removed = v.hide(['toolbox__search_tools']);

    expect(removed).toEqual([]);
    expect(v.isVisible('toolbox__search_tools')).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createSessionVisibility — reset', () => {
  it('empties the revealed set and emits a single change event', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    v.reveal(['jira__search_issues', 'github__create_issue']);

    const events: SessionVisibilityChangeReason[] = [];
    v.on('change', (e) => events.push(e));

    v.reset();

    expect(v.list()).toEqual([]);
    expect(events).toEqual([{ kind: 'reset' }]);
  });

  it('reset on an already-empty set emits no event', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    const listener = vi.fn();
    v.on('change', listener);

    v.reset();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createSessionVisibility — snapshot ordering', () => {
  it('returns bootstrap and revealed names merged, deduped, sorted', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    v.reveal(['jira__search_issues', 'github__create_issue']);
    expect(v.snapshot()).toEqual(
      [
        'github__create_issue',
        'jira__search_issues',
        'toolbox__hide_tools',
        'toolbox__list_available_servers',
        'toolbox__list_revealed_tools',
        'toolbox__reveal_tools',
        'toolbox__search_tools',
      ].sort(),
    );
  });
});

describe('createSessionVisibility — listener lifecycle', () => {
  it('on returns an unsubscribe; further events do not fire after unsubscribe', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    const listener = vi.fn();
    const unsubscribe = v.on('change', listener);

    v.reveal(['jira__search_issues']);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    v.reveal(['github__create_issue']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('throws TypeError when subscribing to an unknown event name', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    expect(() =>
      // Cast to bypass the TS narrowing; the runtime guard exists for JS
      // consumers and typo'd event names.
      v.on('not-a-real-event' as 'change', () => undefined),
    ).toThrow(TypeError);
  });

  it('does not let a throwing listener break the registry or block other listeners', () => {
    const v = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    const ok = vi.fn();
    v.on('change', () => {
      throw new Error('boom');
    });
    v.on('change', ok);

    v.reveal(['jira__search_issues']);

    expect(ok).toHaveBeenCalledTimes(1);
    expect(v.list()).toEqual(['jira__search_issues']);
  });
});

describe('createSessionVisibility — session mode isolation', () => {
  it('two session-mode instances do not share state', () => {
    const a = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    const b = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });

    a.reveal(['jira__search_issues']);

    expect(a.list()).toEqual(['jira__search_issues']);
    expect(b.list()).toEqual([]);
    expect(b.isVisible('jira__search_issues')).toBe(false);
  });

  it('session listeners only receive events from their own instance', () => {
    const a = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    const b = createSessionVisibility({ mode: 'session', bootstrapToolNames: BOOTSTRAP });
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    a.on('change', listenerA);
    b.on('change', listenerB);

    a.reveal(['jira__search_issues']);

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();
  });
});

describe('createSessionVisibility — global mode', () => {
  it('two global-mode instances share the revealed set', () => {
    const a = createSessionVisibility({ mode: 'global', bootstrapToolNames: BOOTSTRAP });
    const b = createSessionVisibility({ mode: 'global', bootstrapToolNames: BOOTSTRAP });

    a.reveal(['jira__search_issues']);

    expect(b.list()).toEqual(['jira__search_issues']);
    expect(b.isVisible('jira__search_issues')).toBe(true);
  });

  it('listeners on one global instance fire when the other reveals', () => {
    const a = createSessionVisibility({ mode: 'global', bootstrapToolNames: BOOTSTRAP });
    const b = createSessionVisibility({ mode: 'global', bootstrapToolNames: BOOTSTRAP });
    const listenerA = vi.fn();
    a.on('change', listenerA);

    b.reveal(['jira__search_issues']);

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerA).toHaveBeenCalledWith({ kind: 'reveal', added: ['jira__search_issues'] });
  });

  it('reset on one global instance is observed by all subscribers exactly once', () => {
    const a = createSessionVisibility({ mode: 'global', bootstrapToolNames: BOOTSTRAP });
    const b = createSessionVisibility({ mode: 'global', bootstrapToolNames: BOOTSTRAP });
    a.reveal(['jira__search_issues']);

    const listenerA = vi.fn();
    const listenerB = vi.fn();
    a.on('change', listenerA);
    b.on('change', listenerB);

    b.reset();

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
    expect(listenerA).toHaveBeenCalledWith({ kind: 'reset' });
    expect(listenerB).toHaveBeenCalledWith({ kind: 'reset' });
    expect(a.list()).toEqual([]);
    expect(b.list()).toEqual([]);
  });

  it('global mode with different bootstrap allowlists per instance keeps bootstrap per-instance', () => {
    const a = createSessionVisibility({ mode: 'global', bootstrapToolNames: ['only_a__tool'] });
    const b = createSessionVisibility({ mode: 'global', bootstrapToolNames: ['only_b__tool'] });

    expect(a.isVisible('only_a__tool')).toBe(true);
    expect(a.isVisible('only_b__tool')).toBe(false);
    expect(b.isVisible('only_a__tool')).toBe(false);
    expect(b.isVisible('only_b__tool')).toBe(true);
  });

  it('list() filters out names that are bootstrap for the calling instance, even if revealed by another global instance', () => {
    const a = createSessionVisibility({ mode: 'global', bootstrapToolNames: ['shared__name'] });
    const b = createSessionVisibility({ mode: 'global', bootstrapToolNames: [] });

    // B has no bootstrap allowlist, so 'shared__name' goes into the shared
    // revealed set. A treats 'shared__name' as bootstrap and must not include
    // it in list().
    b.reveal(['shared__name']);

    expect(b.list()).toEqual(['shared__name']);
    expect(a.list()).toEqual([]);
    expect(a.isVisible('shared__name')).toBe(true);
  });
});
