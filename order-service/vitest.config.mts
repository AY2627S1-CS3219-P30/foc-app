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
      DATABASE_URL: 'postgres://order_service:test@localhost:5432/foc_order_test',
      // Satisfy @foc/auth-client's config at import time; no test opens a connection to them.
      USER_SERVICE_URL: 'http://user-service.test',
      INTERNAL_SERVICE_KEY: 'test-internal-key-0123456789',
    },
  },
});
