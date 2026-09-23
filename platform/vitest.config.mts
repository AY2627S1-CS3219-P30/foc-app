import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests reach a real broker and skip themselves when
    // RABBITMQ_URL is unset, so they need room when it is set.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
