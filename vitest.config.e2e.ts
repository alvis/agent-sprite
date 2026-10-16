import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'open-agent:E2E',
    include: ['e2e/**/*.spec.e2e.ts'],
    globalSetup: ['e2e/setup.ts'],
    fileParallelism: false,
    testTimeout: 5_400_000, // 90 minutes; one real creation can exceed 10
  },
});
