import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The PostgreSQL and RabbitMQ fixture tests reach real servers and skip
    // themselves when TEST_POSTGRES_URL / RABBITMQ_URL are unset.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
