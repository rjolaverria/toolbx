import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';

import { loadOrReportMissing, resolveTargetPath } from '../server-shared.js';
import {
  authTypeOf,
  defaultAuthCommandDeps,
  isOAuthServer,
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

  const tokenStore = deps.createTokenStore(config.auth.storage);
  const stored = await tokenStore.read(serverName);
  if (stored === null) {
    deps.stderr(`No stored token for ${serverName}. Run \`tlbx auth login ${serverName}\`.\n`);
    return 1;
  }

  const entry = config.servers[serverName];
  if (entry === undefined || !isOAuthServer(entry)) {
    const detail = entry === undefined ? 'not configured' : `auth.type is "${authTypeOf(entry)}"`;
    deps.stderr(`Cannot refresh ${serverName}: ${detail}.\n`);
    return 1;
  }

  const result = await deps.runOAuthRefresh({
    serverName,
    serverUrl: new URL(entry.url),
    tokenStore,
    logger: deps.logger,
  });

  if (result.kind === 'success') {
    deps.stdout(`✓ ${serverName} token refreshed.\n`);
    return 0;
  }
  deps.stderr(`Refresh failed: ${result.reason}\n`);
  return 4;
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
