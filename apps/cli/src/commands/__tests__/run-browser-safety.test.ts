import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `tlbx run` must never open a browser implicitly (SPECS §4.6.2, §5.5): the
 * browser-based OAuth flow is owned exclusively by foreground commands the user
 * invokes themselves (`tlbx auth login`, `tlbx server add-http`). These tests
 * prove no `tlbx run` source module reaches the browser-opening OAuth flow —
 * neither `runOAuthLogin` nor a direct `open` import.
 */
const RUN_MODULES = [
  '../run.ts',
  '../run-shared.ts',
  '../run-discovery.ts',
  '../run-daemon.ts',
] as const;

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('tlbx run — browser safety', () => {
  it('no run module references the browser-opening OAuth login flow', () => {
    for (const relative of RUN_MODULES) {
      const source = sourceOf(relative);
      expect(source, `${relative} must not call runOAuthLogin`).not.toMatch(/runOAuthLogin/);
    }
  });

  it('no run module imports the `open` browser launcher', () => {
    // Matches both `from 'open'` and dynamic `import('open')`; deliberately does
    // not match identifiers like `openDaemonClient`.
    const openImport = /import\(\s*['"]open['"]\s*\)|from\s+['"]open['"]/;
    for (const relative of RUN_MODULES) {
      const source = sourceOf(relative);
      expect(source, `${relative} must not import the open module`).not.toMatch(openImport);
    }
  });
});
