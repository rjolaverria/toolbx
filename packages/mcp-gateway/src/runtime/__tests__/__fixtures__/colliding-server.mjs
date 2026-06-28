#!/usr/bin/env node
// Stdio MCP server used by the namespace-collision integration test.
// The upstream tool name is read from `TOOLBX_FIXTURE_TOOL_NAME` so a single
// fixture can be spawned twice with different names — one returning e.g.
// `tool__foo` and another configured under server name `tool` with tool
// `foo`, both producing the exposed name `tool__foo`.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const toolName = process.env['TOOLBX_FIXTURE_TOOL_NAME'];
if (!toolName) {
  process.stderr.write('TOOLBX_FIXTURE_TOOL_NAME is required\n');
  process.exit(2);
}

const server = new Server(
  { name: 'fake-colliding-server', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

const tools = [
  {
    name: toolName,
    description: `Echo for ${toolName}`,
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name !== toolName) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const message = String(args['message'] ?? '');
  return { content: [{ type: 'text', text: `${toolName}:${message}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
