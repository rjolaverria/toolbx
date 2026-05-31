import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'custom-tools',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
