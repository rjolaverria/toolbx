// Fake HTTP MCP server used by upstream-http-client tests.
// Spins up a Node http.Server, attaches a Streamable HTTP MCP transport, and
// exposes:
//   - `echo(message)`         — returns the message back as text content.
//   - `slow({ delayMs })`     — sleeps for `delayMs` before responding.
//
// Optional behavior controlled by the factory options:
//   - `requireBearerToken` — when set to a string, requests without a matching
//     `Authorization: Bearer <value>` header are rejected with 401.
//   - `requireHeaders`     — record of header name → expected value; mismatched
//     requests are rejected with 401.
//
// `start()` returns `{ url, close }`. The URL points at the MCP endpoint.
import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function startHttpEchoServer(options = {}) {
  const { requireBearerToken, requireHeaders = {} } = options;

  const server = new Server(
    { name: 'fake-http-echo-server', version: '0.0.0' },
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
    {
      name: 'slow',
      description: 'Wait for `delayMs` milliseconds before returning.',
      inputSchema: {
        type: 'object',
        properties: { delayMs: { type: 'number' } },
        required: ['delayMs'],
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    switch (name) {
      case 'echo': {
        const message = String(args['message'] ?? '');
        return { content: [{ type: 'text', text: message }] };
      }
      case 'slow': {
        const delayMs = Number(args['delayMs'] ?? 0);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { content: [{ type: 'text', text: `slept ${delayMs}ms` }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // Stateful mode — generate a fresh session ID per connection so subsequent
  // requests (e.g. `notifications/initialized`) are routed to the same
  // transport. We use plain JSON responses to keep the fixture simple.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  transport.onerror = (error) => {
    console.error('http-echo-server: transport error', error);
  };
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (requireBearerToken !== undefined) {
      const auth = req.headers['authorization'];
      const expected = `Bearer ${requireBearerToken}`;
      if (auth !== expected) {
        res.statusCode = 401;
        res.setHeader('content-type', 'text/plain');
        res.end('unauthorized');
        return;
      }
    }
    for (const [name, value] of Object.entries(requireHeaders)) {
      const lower = name.toLowerCase();
      if (req.headers[lower] !== value) {
        res.statusCode = 401;
        res.setHeader('content-type', 'text/plain');
        res.end(`missing header ${name}`);
        return;
      }
    }
    transport.handleRequest(req, res).catch((error) => {
      console.error('http-echo-server: handleRequest failed', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('http-echo-server: failed to bind');
  }
  const url = `http://127.0.0.1:${address.port}/mcp`;

  return {
    url,
    async close() {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve(undefined);
          }
        });
      });
      await server.close();
    },
  };
}
