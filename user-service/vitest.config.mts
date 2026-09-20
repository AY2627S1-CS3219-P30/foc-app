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
      SERVICE_NAME: 'user-service',
      PORT: '3001',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://unused:unused@localhost:1/unused', // never connected: tests use PGlite
      ALLOWED_EMAIL_DOMAINS: 'u.nus.edu,nus.edu.sg',
      INTERNAL_SERVICE_KEYS: 'test-internal-key-0123456789',
    },
  },
});
