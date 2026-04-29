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
