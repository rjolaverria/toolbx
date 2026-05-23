// Combined OAuth authorization server + Streamable HTTP MCP server, on a single
// origin, for exercising the gateway's runtime OAuth path (F1-21).
//
// Why one origin: the MCP SDK's `auth()` re-discovers the authorization server
// from the *resource* (MCP) server URL on each 401 — it does not read the
// authorization server we persisted at login. Serving the OAuth metadata at the
// MCP server's own origin lets the SDK's origin-based discovery resolve it,
// mirroring how a real combined deployment behaves.
//
// Behaviour:
//   - `/.well-known/oauth-authorization-server` → RFC 8414 metadata.
//   - `/.well-known/oauth-protected-resource`   → 404, forcing origin-based
//     AS discovery (the legacy MCP behaviour, matching the core fake server).
//   - `/token` (refresh_token grant)            → issues `refreshAccessToken`
//     (default `refreshed-access-token`) + a rotated refresh token. When
//     `rejectRefresh` is set, responds `invalid_grant`.
//   - `/register` (DCR)                         → echoes a client_id (defensive;
//     the runtime refresh path uses the stored clientInformation instead).
//   - the MCP endpoint (`/mcp`)                 → requires `Authorization:
//     Bearer <t>` where `t` is in the mutable `validTokens` set; otherwise 401.
//
// `start()` returns:
//   { url, issuer, validTokens, authHeaders, tokenGrants, refreshCount, close }
// `validTokens` is a live Set tests can mutate to simulate token rotation or an
// out-of-band `tlbx auth login`.
import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startOAuthMcpServer(options = {}) {
  const {
    validTokens: initialValidTokens = [],
    rejectRefresh = false,
    refreshAccessToken = 'refreshed-access-token',
  } = options;

  const validTokens = new Set(initialValidTokens);
  const authHeaders = [];
  const tokenGrants = [];
  let refreshCount = 0;

  const server = new Server(
    { name: 'fake-oauth-mcp-server', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  const tools = [
    {
      name: 'echo',
      description: 'Return the provided message as text.',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === 'echo') {
      return { content: [{ type: 'text', text: String(args['message'] ?? '') }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  transport.onerror = (error) => {
    console.error('oauth-mcp-server: transport error', error);
  };
  await server.connect(transport);

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

  const httpServer = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', base);
    const json = (status, body) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(200, metadata());
      return;
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const clientMetadata = JSON.parse(await readBody(req));
      json(201, { ...clientMetadata, client_id: 'fake-client-id' });
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const grantType = params.get('grant_type') ?? '';
      tokenGrants.push(grantType);
      if (grantType === 'refresh_token') {
        refreshCount += 1;
        if (rejectRefresh) {
          json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
          return;
        }
        json(200, {
          access_token: refreshAccessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'rotated-refresh-token',
        });
        return;
      }
      json(400, { error: 'unsupported_grant_type' });
      return;
    }

    // Everything else is the MCP endpoint. Enforce the bearer token, then hand
    // off to the Streamable HTTP transport.
    const authHeader = req.headers['authorization'];
    authHeaders.push(authHeader ?? null);
    const token =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length)
        : null;
    if (token === null || !validTokens.has(token)) {
      res.statusCode = 401;
      res.setHeader('content-type', 'text/plain');
      res.end('unauthorized');
      return;
    }
    transport.handleRequest(req, res).catch((error) => {
      console.error('oauth-mcp-server: handleRequest failed', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  }

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('oauth-mcp-server: failed to bind');
  }
  base = new URL(`http://127.0.0.1:${address.port}/`);

  return {
    url: `${base.origin}/mcp`,
    issuer: base.origin,
    validTokens,
    authHeaders,
    tokenGrants,
    refreshCount: () => refreshCount,
    async close() {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve(undefined)));
      });
      await server.close();
    },
  };
}
