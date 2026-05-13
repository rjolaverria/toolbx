#!/usr/bin/env node
// Stdio MCP server used by the reconnect integration test. Mirrors
// `echo-server.mjs` (echo + slow) and adds:
//   - `crash`               — calls `process.exit(1)` to simulate an upstream
//                             dying mid-session. The session module's
//                             retry/backoff loop should reconnect on its own.
//
// A second copy is spawned by the upstream session each time it retries, so
// the recovery side of the test simply waits for `status = connected` again.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'fake-crashable-server', version: '0.0.0' },
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
    name: 'crash',
    description: 'Exit the upstream process with code 1.',
    inputSchema: { type: 'object', properties: {}, required: [] },
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
    case 'crash': {
      // Exit on the next microtask so the response stream isn't trying to
      // serialize while we tear the process down. The transport will close
      // before the gateway receives the result, which is fine — the test
      // doesn't read it.
      setImmediate(() => process.exit(1));
      return { content: [{ type: 'text', text: 'crashing' }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
