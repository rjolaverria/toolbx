import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  ConfigLockError,
  resolveCredentialLockRoot,
  withCredentialLock,
} from '@rjolaverria/toolbox-core';

import { loadOrReportMissing, parsePositiveInt, resolveTargetPath } from '../server-shared.js';
import {
  authTypeOf,
  credentialBusyMessage,
  CREDENTIAL_LOGIN_LOCK_TIMEOUT_MS,
  defaultAuthCommandDeps,
  discoverResourceMetadataUrl,
  isOAuthServer,
  type AuthCommandDeps,
} from './shared.js';

/** Default callback-server wait for the browser handshake: five minutes (§4.6.2). */
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface AuthLoginOptions {
  config?: string;
  timeout?: number;
}

export async function runAuthLogin(
  serverName: string,
  options: AuthLoginOptions,
  deps: AuthCommandDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }

  const entry = config.servers[serverName];
  if (entry === undefined) {
    deps.stderr(
      `Server "${serverName}" is not configured. Run \`tlbx server add-http ...\` first.\n`,
    );
    return 1;
  }
  if (!isOAuthServer(entry)) {
    deps.stderr(
      `Server "${serverName}" is not configured for OAuth (auth.type is "${authTypeOf(entry)}").\n`,
    );
    return 1;
  }
  // The `isOAuthServer` guard narrowed `entry` to an HTTP server, so `url` is present.
  const serverUrl = new URL(entry.url);

  try {
    return await withCredentialLock(
      resolveCredentialLockRoot(config.auth.storage),
      serverName,
      async () => {
        const tokenStore = deps.createTokenStore(config.auth.storage);
        const health = await tokenStore.probe();
        if (health.kind === 'unavailable') {
          deps.stderr(
            `Token storage unavailable: ${health.reason}. Run \`tlbx doctor\` for details.\n`,
          );
          return 3;
        }

        // Recover the RFC 9728 resource-metadata URL so servers whose
        // authorization server is only advertised via the WWW-Authenticate
        // challenge resolve correctly; absent one, the SDK falls back to
        // origin-based discovery.
        const resourceMetadataUrl = await discoverResourceMetadataUrl(deps, serverUrl);

        const abortController = new AbortController();
        const onSigint = (): void => abortController.abort();
        process.on('SIGINT', onSigint);

        deps.stdout(`Opening browser to authenticate ${serverName}…\n`);
        try {
          const result = await deps.runOAuthLogin({
            serverName,
            serverUrl,
            ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
            tokenStore,
            logger: deps.logger,
            abortSignal: abortController.signal,
            // Force the full browser handshake even when a valid token is stored,
            // so the user can switch identities (§4.6.2).
            forceReauth: true,
            callbackTimeoutMs: options.timeout ?? DEFAULT_LOGIN_TIMEOUT_MS,
          });

          switch (result.kind) {
            case 'success':
              deps.stdout(
                `✓ ${serverName} authenticated. ToolBox will use the new token automatically.\n`,
              );
              return 0;
            case 'cancelled':
              deps.stderr(`Login cancelled: ${result.reason}\n`);
              return 2;
            case 'failed':
              deps.stderr(`Login failed: ${result.reason}\n`);
              return 4;
          }
        } finally {
          process.removeListener('SIGINT', onSigint);
        }
      },
      deps.lockOptions ?? { timeoutMs: CREDENTIAL_LOGIN_LOCK_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof ConfigLockError) {
      deps.stderr(credentialBusyMessage(serverName));
      return 1;
    }
    throw err;
  }
}

export function authLoginCommand(): CommandUnknownOpts {
  return new Command('login')
    .description('Authenticate an OAuth upstream server through the browser.')
    .argument('<server>', 'configured server name')
    .option('--timeout <ms>', 'callback wait timeout in milliseconds', parsePositiveInt)
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (server, opts) => {
      const code = await runAuthLogin(server, opts, defaultAuthCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
