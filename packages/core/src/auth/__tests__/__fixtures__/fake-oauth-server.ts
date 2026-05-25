import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

/**
 * Behaviour switches for the fake server. Tests flip these to exercise the
 * failure branches of `runOAuthLogin` without needing a real OAuth provider.
 */
export interface FakeOAuthServerOptions {
  /** `/authorize` redirects with `?error=<this>` instead of a code. */
  authorizeError?: string;
  /** `/authorize` echoes back a different `state` than the one it received. */
  tamperState?: boolean;
  /**
   * Invoked while handling the DCR (`/register`) request — a deterministic
   * point inside the pre-browser discovery phase. Tests use it to fire an
   * abort during the flow's network preflight.
   */
  onRegister?: () => void;
  /** `/token` rejects the `refresh_token` grant with `invalid_grant`. */
  rejectRefresh?: boolean;
  /** `/token` rejects the `refresh_token` grant with a generic server error. */
  rejectRefreshWithServerError?: boolean;
  /**
   * Serve RFC 9728 protected-resource metadata at the well-known path,
   * advertising this server as its own authorization server and its origin as
   * the `resource`. With this on, the SDK selects an RFC 8707 resource
   * indicator during login, so a resource value is persisted into the record.
   */
  serveResourceMetadata?: boolean;
  /**
   * Models a resource-bound authorization server: the `refresh_token` grant is
   * rejected with `invalid_target` unless the request carries a `resource`
   * parameter.
   */
  requireResourceOnRefresh?: boolean;
  /**
   * `/token` rejects the `authorization_code` grant with a server error whose
   * description contains the word "cancelled" — a genuine failure that must NOT
   * be misread as a user cancellation.
   */
  rejectCodeExchange?: boolean;
  /** `/token` rejects the `authorization_code` grant unless it carries `resource`. */
  requireResourceOnCodeExchange?: boolean;
}

export interface FakeOAuthServer {
  /** Base URL the MCP server is reachable at; pass as `serverUrl`. */
  readonly url: URL;
  /** Count of token-endpoint hits, split by grant type, for assertions. */
  readonly tokenGrants: string[];
  /**
   * The `resource` form parameter seen at the token endpoint, one entry per
   * `/token` call (parallel to `tokenGrants`); `null` when the request sent no
   * resource indicator. Lets tests assert the RFC 8707 round-trip.
   */
  readonly tokenResources: Array<string | null>;
  /** Number of DCR (`/register`) calls — lets tests assert client reuse. */
  readonly registrationCount: () => number;
  /** Hits to the authorization-server metadata endpoint — asserts discovery caching. */
  readonly discoveryCount: () => number;
  /** `{ client_id, redirect_uri, resource }` seen at each `/authorize` request. */
  readonly authorizeParams: () => Array<{
    clientId: string | null;
    redirectUri: string | null;
    resource: string | null;
  }>;
  close(): Promise<void>;
}

const sha256Base64Url = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A minimal but spec-faithful OAuth 2.1 authorization server backed by
 * `node:http`. It implements just enough of RFC 8414 discovery, RFC 7591 DCR,
 * the PKCE authorization-code flow, and the refresh-token grant for the MCP
 * SDK's `auth()` driver to complete end to end against a loopback listener.
 */
export async function startFakeOAuthServer(
  options: FakeOAuthServerOptions = {},
): Promise<FakeOAuthServer> {
  const controls: FakeOAuthServerOptions = { ...options };
  const tokenGrants: string[] = [];
  const tokenResources: Array<string | null> = [];
  let registrations = 0;
  let discoveries = 0;
  const authorizeParams: Array<{
    clientId: string | null;
    redirectUri: string | null;
    resource: string | null;
  }> = [];
  // code -> the PKCE code_challenge presented at /authorize, so /token can
  // verify the matching code_verifier (proves the SDK round-tripped PKCE).
  const issuedCodes = new Map<string, string>();

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  let base = new URL('http://127.0.0.1/');

  const metadata = () => ({
    issuer: base.origin,
    authorization_endpoint: new URL('/authorize', base).toString(),
    token_endpoint: new URL('/token', base).toString(),
    registration_endpoint: new URL('/register', base).toString(),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });

  async function handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', base);
    const json = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };

    // RFC 9728 protected-resource metadata is unimplemented by default:
    // discovery falls back to treating the MCP server origin as the
    // authorization server (the legacy MCP behaviour). When
    // `serveResourceMetadata` is on, we advertise ourselves so the SDK selects
    // an RFC 8707 resource indicator.
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      if (controls.serveResourceMetadata) {
        json(200, {
          resource: base.origin,
          authorization_servers: [base.origin],
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      discoveries += 1;
      json(200, metadata());
      return;
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      registrations += 1;
      const clientMetadata = JSON.parse(await readBody(req)) as Record<string, unknown>;
      controls.onRegister?.();
      json(201, { ...clientMetadata, client_id: 'fake-client-id' });
      return;
    }
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const codeChallenge = url.searchParams.get('code_challenge');
      authorizeParams.push({
        clientId: url.searchParams.get('client_id'),
        redirectUri,
        resource: url.searchParams.get('resource'),
      });
      if (!redirectUri || !state || !codeChallenge) {
        res.statusCode = 400;
        res.end('missing authorize params');
        return;
      }
      const location = new URL(redirectUri);
      const echoedState = controls.tamperState ? `${state}-tampered` : state;
      location.searchParams.set('state', echoedState);
      if (controls.authorizeError) {
        location.searchParams.set('error', controls.authorizeError);
      } else {
        const code = randomUUID();
        issuedCodes.set(code, codeChallenge);
        location.searchParams.set('code', code);
      }
      res.statusCode = 302;
      res.setHeader('location', location.toString());
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const grantType = params.get('grant_type') ?? '';
      tokenGrants.push(grantType);
      tokenResources.push(params.get('resource'));
      if (grantType === 'authorization_code') {
        if (controls.rejectCodeExchange) {
          json(500, { error: 'server_error', error_description: 'upstream request was cancelled' });
          return;
        }
        if (controls.requireResourceOnCodeExchange && !params.get('resource')) {
          json(400, {
            error: 'invalid_target',
            error_description: 'resource indicator required on code exchange',
          });
          return;
        }
        const code = params.get('code') ?? '';
        const codeVerifier = params.get('code_verifier') ?? '';
        const expectedChallenge = issuedCodes.get(code);
        if (!expectedChallenge || sha256Base64Url(codeVerifier) !== expectedChallenge) {
          json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
          return;
        }
        issuedCodes.delete(code);
        json(200, {
          access_token: 'fake-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'fake-refresh-token',
        });
        return;
      }
      if (grantType === 'refresh_token') {
        if (controls.rejectRefreshWithServerError) {
          json(500, { error: 'server_error', error_description: 'refresh temporarily failed' });
          return;
        }
        if (controls.rejectRefresh) {
          json(400, { error: 'invalid_grant', error_description: 'refresh token expired' });
          return;
        }
        if (controls.requireResourceOnRefresh && !params.get('resource')) {
          json(400, {
            error: 'invalid_target',
            error_description: 'resource indicator required on refresh',
          });
          return;
        }
        json(200, {
          access_token: 'refreshed-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'rotated-refresh-token',
        });
        return;
      }
      json(400, { error: 'unsupported_grant_type' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  base = new URL(`http://127.0.0.1:${addr.port}/`);

  return {
    url: base,
    tokenGrants,
    tokenResources,
    registrationCount: () => registrations,
    discoveryCount: () => discoveries,
    authorizeParams: () => authorizeParams,
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export interface FakeResourceServerOptions {
  /** Authorization servers advertised by the protected-resource metadata. */
  authorizationServers: URL[];
}

export interface FakeResourceServer {
  /** Base URL of the MCP resource server; pass as `serverUrl`. */
  readonly url: URL;
  /** RFC 9728 metadata URL; pass as `resourceMetadataUrl`. */
  readonly resourceMetadataUrl: URL;
  close(): Promise<void>;
}

/**
 * A bare RFC 9728 protected-resource server. It serves its metadata ONLY at an
 * explicit, non-default path and 404s everything else — including the root
 * `/.well-known/oauth-protected-resource` and all OAuth endpoints. Discovery
 * therefore only finds the authorization server when the caller threads the
 * explicit `resourceMetadataUrl` through; falling back to origin-based
 * discovery fails. This lets a test prove every `auth()` phase honours
 * `resourceMetadataUrl`.
 */
export async function startFakeResourceServer(
  options: FakeResourceServerOptions,
): Promise<FakeResourceServer> {
  // A non-default, path-based metadata location so the SDK's origin fallback
  // (root `/.well-known/oauth-protected-resource`) misses it.
  const prmPath = '/.well-known/oauth-protected-resource/mcp';
  let base = new URL('http://127.0.0.1/');

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (url.pathname === prmPath) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          resource: base.origin,
          authorization_servers: options.authorizationServers.map((u) => u.toString()),
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  base = new URL(`http://127.0.0.1:${addr.port}/`);

  return {
    url: base,
    resourceMetadataUrl: new URL(prmPath, base),
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
