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
      SERVICE_NAME: 'supplier-service',
      PORT: '3002',
      LOG_LEVEL: 'silent',
      // The integration suites override DB and the authenticator with test
      // doubles (auth-integration.test.ts instead points the real authenticator
      // at a fake User Service it starts itself); these satisfy config
      // validation at import time. Nothing here is a real endpoint — no test
      // opens a connection to them.
      DATABASE_URL: 'postgres://supplier_service:test@localhost:5432/foc_supplier_test',
      USER_SERVICE_URL: 'http://user-service.test',
      INTERNAL_SERVICE_KEY: 'test-internal-key-0123456789',
    },
  },
});
