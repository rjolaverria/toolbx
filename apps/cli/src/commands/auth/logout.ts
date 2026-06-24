import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  ConfigLockError,
  resolveCredentialLockRoot,
  withCredentialLock,
} from '@rjolaverria/toolbox-core';

import { loadOrReportMissing, resolveTargetPath } from '../server-shared.js';
import {
  credentialBusyMessage,
  CREDENTIAL_CONTENTION_LOCK_TIMEOUT_MS,
  defaultAuthCommandDeps,
  type AuthCommandDeps,
} from './shared.js';

export interface AuthLogoutOptions {
  config?: string;
}

export async function runAuthLogout(
  serverName: string,
  options: AuthLogoutOptions,
  deps: AuthCommandDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }

  // Serialize against any concurrent same-name credential command (e.g. an
  // `add-http`/`auth login` mid-flow) so logout cannot delete a token while
  // another command is between its login write and its config save/rollback.
  try {
    return await withCredentialLock(
      resolveCredentialLockRoot(config.auth.storage),
      serverName,
      async () => {
        // Logout never edits config.json — it only clears stored credentials, so
        // a server whose entry was already removed can still have a stale token
        // cleared.
        const tokenStore = deps.createTokenStore(config.auth.storage);

        // Probe for an existing record only to choose the message. A corrupt or
        // schema-incompatible record throws on read — but logout must still be
        // able to clear exactly that kind of bad entry, so a read failure must
        // not block the delete. Treat an unreadable record as present and proceed.
        let hadToken: boolean;
        try {
          hadToken = (await tokenStore.read(serverName)) !== null;
        } catch {
          hadToken = true;
        }

        try {
          await tokenStore.delete(serverName);
        } catch (error) {
          deps.stderr(`Logout failed: ${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        }

        deps.stdout(
          hadToken
            ? `✓ ${serverName} logged out.\n`
            : `✓ ${serverName} logged out (no token was stored).\n`,
        );
        return 0;
      },
      deps.lockOptions ?? { timeoutMs: CREDENTIAL_CONTENTION_LOCK_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof ConfigLockError) {
      deps.stderr(credentialBusyMessage(serverName));
      return 1;
    }
    throw err;
  }
}

export function authLogoutCommand(): CommandUnknownOpts {
  return new Command('logout')
    .description('Delete the stored OAuth credentials for a server (leaves config intact).')
    .argument('<server>', 'configured server name')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (server, opts) => {
      const code = await runAuthLogout(server, opts, defaultAuthCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
