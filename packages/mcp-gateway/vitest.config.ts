import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'mcp-gateway',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
