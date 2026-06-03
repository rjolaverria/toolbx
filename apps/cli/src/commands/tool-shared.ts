import * as path from 'node:path';
import * as readline from 'node:readline/promises';

import { ToolManifestError } from '@toolbox/custom-tools';

import {
  defaultServerCommandDeps,
  resolveTargetPath,
  type ServerCommandDeps,
} from './server-shared.js';

/**
 * Custom-tool commands share the upstream-server command plumbing (config-path
 * resolution, stdout/stderr sinks). The manifest lives under the config
 * directory, so the only extra primitive these commands need is the config
 * directory itself plus, for destructive commands, an interactive confirmer.
 */
export type ToolCommandDeps = ServerCommandDeps;

export const defaultToolCommandDeps = defaultServerCommandDeps;

export { resolveTargetPath };

/** Resolves the ToolBox config directory that holds the `tools/` subtree. */
export function resolveConfigDir(deps: ToolCommandDeps, override: string | undefined): string {
  return path.dirname(resolveTargetPath(deps, override));
}

export interface ConfirmDeps {
  isTty: () => boolean;
  confirm: (question: string) => Promise<boolean>;
}

export function defaultConfirmDeps(): ConfirmDeps {
  return {
    isTty: () => process.stdin.isTTY === true,
    confirm: async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(question);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * Reports a manifest read/lookup failure to stderr and returns the exit code to
 * use. A missing tool is the caller's fault (exit 1); a corrupt manifest is a
 * config problem the user must repair (exit 1 as well, with a distinct message).
 */
export function reportManifestError(error: ToolManifestError, deps: ToolCommandDeps): number {
  deps.stderr(`${error.message}\n`);
  return 1;
}
