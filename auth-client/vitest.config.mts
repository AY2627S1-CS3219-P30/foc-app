import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    env: {
      // Only the integration test boots the real User Service in-process; it needs its config.
      NODE_ENV: 'test',
      SERVICE_NAME: 'auth-client-test',
      PORT: '3001',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://unused:unused@localhost:1/unused', // never connected: PGlite
      ALLOWED_EMAIL_DOMAINS: 'u.nus.edu,nus.edu.sg',
      INTERNAL_SERVICE_KEYS: 'test-internal-key-0123456789',
    },
  },
});
