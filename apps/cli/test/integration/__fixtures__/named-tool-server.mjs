#!/usr/bin/env node
// Stdio MCP fixture used by the CLI integration tests for namespace
// collision detection. Exposes a single tool whose name is read from the
// TOOLBX_FIXTURE_TOOL_NAME env var (default: `echo`). The tool returns the
// `message` argument verbatim so the collision test can still drive a real
// tools/call round-trip if it wants to.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const toolName = process.env['TOOLBX_FIXTURE_TOOL_NAME'] ?? 'echo';

const server = new Server(
  { name: 'fake-named-tool-server', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: toolName,
      description: `Return the provided message as text under tool name "${toolName}".`,
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name !== toolName) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const message = String(args['message'] ?? '');
  return { content: [{ type: 'text', text: message }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
