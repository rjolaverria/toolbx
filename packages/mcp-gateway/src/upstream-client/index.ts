export { createStdioUpstreamClient, type CreateStdioUpstreamClientDeps } from './stdio.js';
export { createHttpUpstreamClient, type CreateHttpUpstreamClientDeps } from './http.js';
export {
  UpstreamAuthRequiredError,
  UpstreamCallToolTimeoutError,
  UpstreamConnectError,
  UpstreamMissingEnvVarError,
  UpstreamNotConnectedError,
} from './errors.js';
export { resolveEnvPlaceholders, type ResolveEnvOptions } from './env.js';
export {
  createUpstreamSession,
  type CreateUpstreamSessionDeps,
  type UpstreamClientFactory,
  type UpstreamSession,
  type UpstreamSessionBackoff,
  type UpstreamSessionEvent,
  type UpstreamSessionEvents,
  type UpstreamSessionScheduler,
} from './session.js';
export type {
  CallToolResult,
  ListToolsResult,
  UpstreamCallToolOptions,
  UpstreamClient,
  UpstreamClientEvent,
  UpstreamClientEvents,
  UpstreamExitInfo,
  UpstreamLogEntry,
} from './types.js';
