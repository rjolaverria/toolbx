#!/usr/bin/env node
// Fake stdio MCP server used by upstream-stdio-client tests.
// Exposes:
//   - `echo(message)`         — returns the message back as text content.
//   - `slow({ delayMs })`     — sleeps for `delayMs` before responding.
//   - `emit_log(message)`     — writes a line to stderr; useful for testing
//     the upstream client's stderr forwarding.
//
// Honors a few optional environment variables, set by tests:
//   - TOOLBX_FIXTURE_STARTUP_STDERR — printed to stderr right after start.
//   - TOOLBX_FIXTURE_REQUIRED_ENV  — bails out unless that var is present.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const required = process.env['TOOLBX_FIXTURE_REQUIRED_ENV'];
if (required && !process.env[required]) {
  process.stderr.write(`fixture: missing required env ${required}\n`);
  process.exit(2);
}

const startupStderr = process.env['TOOLBX_FIXTURE_STARTUP_STDERR'];
if (startupStderr) {
  process.stderr.write(`${startupStderr}\n`);
}

const server = new Server(
  { name: 'fake-echo-server', version: '0.0.0' },
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
  {
    name: 'emit_log',
    description: 'Emit a line on stderr.',
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
    case 'emit_log': {
      const message = String(args['message'] ?? '');
      process.stderr.write(`${message}\n`);
      return { content: [{ type: 'text', text: 'logged' }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
