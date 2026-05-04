import { describe, expect, it, vi } from 'vitest';

import type { ServerConfig, ToolBoxConfig } from '../../config/schema.js';
import {
  createStatusRegistry,
  UnknownServerError,
  type LogLine,
  type ServerStatusEntry,
} from '../registry.js';
import { InvalidStatusTransitionError } from '../state-machine.js';
import type { ServerStatus } from '../types.js';

const baseConfig: Omit<ToolBoxConfig, 'servers'> = {
  $schema: 'https://toolbox.dev/schema/config.schema.json',
  version: 1,
  server: {
    stdio: { enabled: true },
    http: { enabled: true, host: '127.0.0.1', port: 7331, path: '/mcp' },
  },
  progressiveDisclosure: {
    enabled: true,
    mode: 'session',
    bootstrapTools: true,
    autoRevealExactServerMatches: true,
    maxSearchResults: 20,
  },
  namespacing: {
    separator: '__',
    format: 'server__tool',
    collisionStrategy: 'error',
  },
};

function configWith(servers: Record<string, ServerConfig>): ToolBoxConfig {
  return { ...baseConfig, servers };
}

const stdioEnabled: ServerConfig = {
  type: 'stdio',
  enabled: true,
  command: 'node',
  args: [],
};
const stdioDisabled: ServerConfig = {
  type: 'stdio',
  enabled: false,
  command: 'node',
  args: [],
};
const httpWithBearer: ServerConfig = {
  type: 'http',
  enabled: true,
  url: 'https://api.example.com/mcp',
  auth: { type: 'bearer', tokenEnv: 'API_TOKEN' },
};

describe('createStatusRegistry — initialization', () => {
  it('creates one entry per configured server, including disabled ones', () => {
    const registry = createStatusRegistry(
      configWith({
        alpha: stdioEnabled,
        beta: stdioDisabled,
        gamma: httpWithBearer,
      }),
    );
    const list = registry.list();
    expect(list.map((e) => e.name)).toEqual(['alpha', 'beta', 'gamma']);

    const alpha = registry.get('alpha');
    expect(alpha?.status).toEqual({ kind: 'stopped' });
    expect(alpha?.transport).toBe('stdio');
    expect(alpha?.enabled).toBe(true);
    expect(alpha?.toolCount).toBe(0);
    expect(alpha?.lastConnectedAt).toBeNull();
    expect(alpha?.lastError).toBeNull();
    expect(alpha?.recentLogs).toEqual([]);
    expect(alpha?.authStatus).toBe('none');

    const beta = registry.get('beta');
    expect(beta?.status).toEqual({ kind: 'disabled' });
    expect(beta?.enabled).toBe(false);
    expect(beta?.authStatus).toBe('none');

    const gamma = registry.get('gamma');
    expect(gamma?.transport).toBe('http');
    expect(gamma?.status).toEqual({ kind: 'stopped' });
    expect(gamma?.authStatus).toBe('none');
  });

  it('rejects a non-positive recentLogsLimit', () => {
    expect(() => createStatusRegistry(configWith({}), { recentLogsLimit: 0 })).toThrow(RangeError);
    expect(() => createStatusRegistry(configWith({}), { recentLogsLimit: -1 })).toThrow(RangeError);
    expect(() => createStatusRegistry(configWith({}), { recentLogsLimit: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe('createStatusRegistry — update', () => {
  it('throws UnknownServerError for unknown server names', () => {
    const registry = createStatusRegistry(configWith({ alpha: stdioEnabled }));
    expect(() => registry.update('nope', { status: { kind: 'starting', attempt: 1 } })).toThrow(
      UnknownServerError,
    );
    expect(() => registry.appendLog('nope', logLine('hi'))).toThrow(UnknownServerError);
  });

  it('rejects invalid transitions with the typed state-machine error', () => {
    const registry = createStatusRegistry(configWith({ alpha: stdioEnabled }));
    expect(() =>
      registry.update('alpha', {
        status: { kind: 'connected', since: new Date() },
      }),
    ).toThrow(InvalidStatusTransitionError);
  });

  it('drives the happy-path lifecycle and updates derived fields', () => {
    const fixedNow = new Date('2026-04-29T10:00:00.000Z');
    const registry = createStatusRegistry(configWith({ alpha: stdioEnabled }), {
      now: () => fixedNow,
    });

    registry.update('alpha', { status: { kind: 'starting', attempt: 1 } });
    expect(registry.get('alpha')?.status.kind).toBe('starting');

    const since = new Date('2026-04-29T10:00:01.000Z');
    const connected = registry.update('alpha', { status: { kind: 'connected', since } });
    expect(connected.lastConnectedAt).toEqual(since);
    expect(connected.toolCount).toBe(0);

    registry.update('alpha', { toolCount: 7 });
    expect(registry.get('alpha')?.toolCount).toBe(7);

    const err = new Error('boom');
    registry.update('alpha', {
      status: { kind: 'error', error: err, nextRetryAt: null },
    });
    const afterError = registry.get('alpha');
    expect(afterError?.status.kind).toBe('error');
    expect(afterError?.lastError).toEqual({ message: 'boom', at: fixedNow });
    // lastConnectedAt persists through error.
    expect(afterError?.lastConnectedAt).toEqual(since);
    // toolCount persists through status changes.
    expect(afterError?.toolCount).toBe(7);
  });

  it('derives authStatus from status.kind and the server auth config', () => {
    const registry = createStatusRegistry(
      configWith({ alpha: stdioEnabled, gamma: httpWithBearer }),
    );

    registry.update('alpha', { status: { kind: 'starting', attempt: 1 } });
    registry.update('alpha', {
      status: { kind: 'connected', since: new Date() },
    });
    // stdio server with no auth → 'none' even when connected.
    expect(registry.get('alpha')?.authStatus).toBe('none');

    registry.update('gamma', { status: { kind: 'starting', attempt: 1 } });
    registry.update('gamma', {
      status: { kind: 'connected', since: new Date() },
    });
    expect(registry.get('gamma')?.authStatus).toBe('ok');

    registry.update('gamma', {
      status: { kind: 'auth_expired', reason: 'expired' },
    });
    expect(registry.get('gamma')?.authStatus).toBe('expired');

    registry.update('gamma', {
      status: { kind: 'auth_required', reason: 'refresh failed' },
    });
    expect(registry.get('gamma')?.authStatus).toBe('required');
  });

  it('rejects invalid toolCount values with a RangeError', () => {
    const registry = createStatusRegistry(configWith({ alpha: stdioEnabled }));
    expect(() => registry.update('alpha', { toolCount: -1 })).toThrow(RangeError);
    expect(() => registry.update('alpha', { toolCount: 1.5 })).toThrow(RangeError);
    expect(() => registry.update('alpha', { toolCount: Number.NaN })).toThrow(RangeError);
    expect(() => registry.update('alpha', { toolCount: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    // Zero is a valid count.
    expect(() => registry.update('alpha', { toolCount: 0 })).not.toThrow();
    // toolCount must be unchanged after the rejected updates.
    expect(registry.get('alpha')?.toolCount).toBe(0);
  });

  it('updates the enabled flag without coupling it to status', () => {
    const registry = createStatusRegistry(configWith({ alpha: stdioEnabled }));
    registry.update('alpha', { enabled: false });
    expect(registry.get('alpha')?.enabled).toBe(false);
    // status is unchanged — caller is responsible for orchestration.
    expect(registry.get('alpha')?.status).toEqual({ kind: 'stopped' });
  });
});

describe('createStatusRegistry — appendLog', () => {
  it('appends log lines and rotates oldest-first when over the limit', () => {
    const registry = createStatusRegistry(configWith({ alpha: stdioEnabled }), {
      recentLogsLimit: 3,
    });

    for (let i = 0; i < 5; i += 1) {
      registry.appendLog('alpha', logLine(`line ${String(i)}`));
    }
    const logs = registry.get('alpha')?.recentLogs ?? [];
    expect(logs.map((l) => l.message)).toEqual(['line 2', 'line 3', 'line 4']);
  });

  it('uses the default limit of 100 when not configured', () => {
    const registry = createStatusRegistry(configWith({ alpha: stdioEnabled }));
    for (let i = 0; i < 105; i += 1) {
      registry.appendLog('alpha', logLine(`line ${String(i)}`));
    }
    const logs = registry.get('alpha')?.recentLogs ?? [];
    expect(logs).toHaveLength(100);
    expect(logs[0]?.message).toBe('line 5');
    expect(logs[99]?.message).toBe('line 104');
  });
});

describe('createStatusRegistry — subscribe', () => {
  it('fires on every entry change and supports unsubscribe', () => {
    const registry = createStatusRegistry(configWith({ alpha: stdioEnabled }));
    const calls: { name: string; statusKind: string }[] = [];
    const unsubscribe = registry.subscribe((name, entry) => {
      calls.push({ name, statusKind: entry.status.kind });
    });

    registry.update('alpha', { status: { kind: 'starting', attempt: 1 } });
    registry.appendLog('alpha', logLine('hello'));
    registry.update('alpha', {
      status: { kind: 'connected', since: new Date() },
    });

    expect(calls).toEqual([
      { name: 'alpha', statusKind: 'starting' },
      { name: 'alpha', statusKind: 'starting' }, // appendLog: status unchanged
      { name: 'alpha', statusKind: 'connected' },
    ]);

    unsubscribe();
    registry.update('alpha', { toolCount: 1 });
    expect(calls).toHaveLength(3);
  });

  it('does not let a throwing listener break the registry or block other listeners', () => {
    const registry = createStatusRegistry(configWith({ alpha: stdioEnabled }));
    registry.subscribe(() => {
      throw new Error('boom');
    });
    const second = vi.fn();
    registry.subscribe(second);
    expect(() =>
      registry.update('alpha', { status: { kind: 'starting', attempt: 1 } }),
    ).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('createStatusRegistry — integration with an upstream session', () => {
  it('forwards session status events into the registry', () => {
    const registry = createStatusRegistry(configWith({ alpha: stdioEnabled }));
    const session = createFakeSession();
    session.on('status', (status) => {
      registry.update('alpha', { status });
    });

    session.emitStatus({ kind: 'starting', attempt: 1 });
    session.emitStatus({ kind: 'connected', since: new Date('2026-04-29T10:00:00.000Z') });

    const entry = registry.get('alpha');
    expect(entry?.status.kind).toBe('connected');
    expect(entry?.lastConnectedAt?.toISOString()).toBe('2026-04-29T10:00:00.000Z');
  });
});

function logLine(message: string, level: LogLine['level'] = 'info'): LogLine {
  return { at: new Date(), level, message };
}

function createFakeSession(): {
  on: (event: 'status', handler: (s: ServerStatus) => void) => void;
  emitStatus: (s: ServerStatus) => void;
} {
  const handlers = new Set<(s: ServerStatus) => void>();
  return {
    on(_event, handler) {
      handlers.add(handler);
    },
    emitStatus(s) {
      for (const h of handlers) {
        h(s);
      }
    },
  };
}

// Ensure `ServerStatusEntry` is reachable from this file; helps catch
// accidental removal of the export.
const _typeProbe: ServerStatusEntry | undefined = undefined;
void _typeProbe;
