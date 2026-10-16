import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'open-agent:E2E',
    include: ['spec/e2e/**/*.spec.e2e.ts'],
  },
});
