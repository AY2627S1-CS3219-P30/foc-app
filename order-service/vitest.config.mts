import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    // The suite supplies its own configuration so `npm test` works on a clean
    // clone without anyone exporting variables into their shell first.
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'order-service',
      PORT: '3003',
      LOG_LEVEL: 'silent',
    },
  },
});
