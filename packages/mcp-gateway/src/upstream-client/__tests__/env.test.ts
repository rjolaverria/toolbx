import { describe, expect, it } from 'vitest';

import { resolveEnvPlaceholders } from '../env.js';
import { UpstreamMissingEnvVarError } from '../errors.js';

describe('resolveEnvPlaceholders', () => {
  it('returns undefined when no env override is supplied', () => {
    expect(resolveEnvPlaceholders({ env: undefined })).toBeUndefined();
  });

  it('passes through values without placeholders unchanged', () => {
    const out = resolveEnvPlaceholders({
      env: { FOO: 'bar', BAZ: 'qux' },
      processEnv: {},
    });
    expect(out).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('substitutes ${env:NAME} placeholders from the supplied processEnv', () => {
    const out = resolveEnvPlaceholders({
      env: { TOKEN: '${env:MY_TOKEN}', MIXED: 'pre-${env:TAIL}-post' },
      processEnv: { MY_TOKEN: 'secret', TAIL: 'xyz' },
    });
    expect(out).toEqual({ TOKEN: 'secret', MIXED: 'pre-xyz-post' });
  });

  it('throws UpstreamMissingEnvVarError when a referenced var is unset', () => {
    expect(() =>
      resolveEnvPlaceholders({
        env: { TOKEN: '${env:NOT_SET}' },
        processEnv: {},
        serverName: 'jira',
      }),
    ).toThrowError(UpstreamMissingEnvVarError);
  });

  it('attaches the server and var name on the typed error', () => {
    let caught: unknown;
    try {
      resolveEnvPlaceholders({
        env: { A: '${env:MISSING}' },
        processEnv: {},
        serverName: 'github',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UpstreamMissingEnvVarError);
    if (caught instanceof UpstreamMissingEnvVarError) {
      expect(caught.varName).toBe('MISSING');
      expect(caught.serverName).toBe('github');
    }
  });

  it('does not mutate the supplied env map', () => {
    const env = { TOKEN: '${env:T}' };
    resolveEnvPlaceholders({ env, processEnv: { T: '1' } });
    expect(env).toEqual({ TOKEN: '${env:T}' });
  });
});
