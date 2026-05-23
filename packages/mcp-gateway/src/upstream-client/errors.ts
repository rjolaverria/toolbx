export class UpstreamMissingEnvVarError extends Error {
  override readonly name = 'UpstreamMissingEnvVarError';

  constructor(
    public readonly varName: string,
    public readonly serverName: string | undefined,
  ) {
    const where = serverName ? ` (server "${serverName}")` : '';
    super(`Required environment variable "${varName}" is not set${where}.`);
  }
}

export class UpstreamConnectError extends Error {
  override readonly name = 'UpstreamConnectError';

  constructor(
    message: string,
    public readonly serverName: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class UpstreamCallToolTimeoutError extends Error {
  override readonly name = 'UpstreamCallToolTimeoutError';

  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
    public readonly serverName: string | undefined,
    options?: { cause?: unknown },
  ) {
    const where = serverName ? ` on server "${serverName}"` : '';
    super(`Upstream tool "${toolName}"${where} timed out after ${timeoutMs}ms.`, options);
  }
}

export class UpstreamNotConnectedError extends Error {
  override readonly name = 'UpstreamNotConnectedError';

  constructor(serverName: string | undefined) {
    const where = serverName ? ` "${serverName}"` : '';
    super(`Upstream client${where} is not connected.`);
  }
}

export class UpstreamAuthRequiredError extends Error {
  override readonly name = 'UpstreamAuthRequiredError';

  public readonly tokenEnv: string | undefined;

  constructor(
    message: string,
    public readonly serverName: string | undefined,
    options?: { cause?: unknown; tokenEnv?: string },
  ) {
    super(message, options);
    this.tokenEnv = options?.tokenEnv;
  }

  static forMissingBearerToken(
    tokenEnv: string,
    serverName: string | undefined,
  ): UpstreamAuthRequiredError {
    const where = serverName ? ` for server "${serverName}"` : '';
    return new UpstreamAuthRequiredError(
      `Authentication required${where}: bearer token environment variable "${tokenEnv}" is not set.`,
      serverName,
      { tokenEnv },
    );
  }

  static forMissingOAuthToken(serverName: string | undefined): UpstreamAuthRequiredError {
    const where = serverName ? ` for server "${serverName}"` : '';
    const loginArg = serverName ? ` ${serverName}` : '';
    return new UpstreamAuthRequiredError(
      `Authentication required${where}: no stored OAuth token. Run \`tlbx auth login${loginArg}\` to authenticate.`,
      serverName,
    );
  }
}

/**
 * Raised when an OAuth-protected upstream rejects the stored credentials and
 * the SDK's refresh-on-401 path cannot recover them (refresh token expired or
 * revoked, or no refresh token to use). Distinct from
 * `UpstreamAuthRequiredError`: a stored record *exists*, it has simply aged
 * out, so the session transitions to `auth_expired` rather than `auth_required`
 * and the recovery surface is the structured tool-call message (SPECS §4.6.2).
 */
export class UpstreamAuthExpiredError extends Error {
  override readonly name = 'UpstreamAuthExpiredError';

  constructor(
    public readonly serverName: string | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  static forServer(serverName: string | undefined, cause?: unknown): UpstreamAuthExpiredError {
    const where = serverName ? ` for server "${serverName}"` : '';
    const loginArg = serverName ? ` ${serverName}` : '';
    return new UpstreamAuthExpiredError(
      serverName,
      `Authentication expired${where}: stored OAuth token could not be refreshed. Run \`tlbx auth login${loginArg}\` to re-authenticate.`,
      cause !== undefined ? { cause } : undefined,
    );
  }
}
