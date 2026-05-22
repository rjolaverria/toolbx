import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';

import { loadOrReportMissing, resolveTargetPath } from '../server-shared.js';
import { defaultAuthCommandDeps, type AuthCommandDeps } from './shared.js';

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

  // Logout never edits config.json — it only clears stored credentials, so a
  // server whose entry was already removed can still have a stale token cleared.
  const tokenStore = deps.createTokenStore(config.auth.storage);
  try {
    const existing = await tokenStore.read(serverName);
    if (existing === null) {
      deps.stdout(`✓ ${serverName} logged out (no token was stored).\n`);
      return 0;
    }
    await tokenStore.delete(serverName);
    deps.stdout(`✓ ${serverName} logged out.\n`);
    return 0;
  } catch (error) {
    deps.stderr(`Logout failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
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
