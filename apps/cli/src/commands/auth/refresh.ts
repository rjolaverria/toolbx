import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { ConfigLockError, resolveCredentialLockRoot, withCredentialLock } from '@toolbx/core';

import { loadOrReportMissing, resolveTargetPath } from '../server-shared.js';
import {
  credentialBusyMessage,
  CREDENTIAL_CONTENTION_LOCK_TIMEOUT_MS,
  defaultAuthCommandDeps,
  type AuthCommandDeps,
} from './shared.js';

export interface AuthRefreshOptions {
  config?: string;
}

export async function runAuthRefresh(
  serverName: string,
  options: AuthRefreshOptions,
  deps: AuthCommandDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }

  // Serialize against any concurrent same-name credential command so refresh's
  // read-then-write cannot interleave with a logout/login/add-http on the same key.
  try {
    return await withCredentialLock(
      resolveCredentialLockRoot(config.auth.storage),
      serverName,
      async () => {
        const tokenStore = deps.createTokenStore(config.auth.storage);
        let stored;
        try {
          stored = await tokenStore.read(serverName);
        } catch (error) {
          // A keychain backend can throw on locked/unavailable storage or a
          // corrupt record; surface a readable diagnostic instead of an
          // unhandled crash.
          deps.stderr(
            `Could not read stored credentials for ${serverName}: ${
              error instanceof Error ? error.message : String(error)
            }. Run \`tlbx doctor\` for details.\n`,
          );
          return 1;
        }
        if (stored === null) {
          deps.stderr(
            `No stored token for ${serverName}. Run \`tlbx auth login ${serverName}\`.\n`,
          );
          return 1;
        }

        // Refresh runs entirely off the stored record (authorization server,
        // client info, refresh token), so it does not need the config server
        // entry or a network probe of the resource server.
        const result = await deps.runOAuthRefresh({
          serverName,
          tokenStore,
          logger: deps.logger,
        });

        if (result.kind === 'success') {
          deps.stdout(`✓ ${serverName} token refreshed.\n`);
          return 0;
        }
        deps.stderr(`Refresh failed: ${result.reason}\n`);
        return 4;
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

export function authRefreshCommand(): CommandUnknownOpts {
  return new Command('refresh')
    .description('Refresh a server’s stored OAuth token without opening the browser.')
    .argument('<server>', 'configured server name')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (server, opts) => {
      const code = await runAuthRefresh(server, opts, defaultAuthCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
