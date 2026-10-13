import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Every suite needs real PostgreSQL and skips itself when TEST_POSTGRES_URL is unset.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Both services' modules read their configuration at import time. Nothing here is
    // contacted: each test hands the repositories their own ephemeral databases.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'system-tests',
      PORT: '3999',
      DATABASE_URL: 'postgres://unused@localhost:5432/unused',
      USER_SERVICE_URL: 'http://user-service.test',
      SUPPLIER_SERVICE_URL: 'http://supplier-service.test',
      CREDIT_SERVICE_URL: 'http://credit-service.test',
      INTERNAL_SERVICE_KEY: 'test-internal-key-0123456789',
      INTERNAL_SERVICE_KEYS: 'test-internal-key-0123456789',
      CREDIT_WAIT_TIMEOUT_MS: '300000',
      ACCEPTANCE_WINDOW_MS: '3600000',
      PICKUP_TIMEOUT_MS: '1800000',
      LIFECYCLE_SWEEP_INTERVAL_MS: '10000',
      RECONCILE_INTERVAL_MS: '60000',
      RECONCILE_RETRY_MS: '300000',
    },
  },
});
