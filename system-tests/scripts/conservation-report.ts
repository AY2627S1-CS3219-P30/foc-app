/**
 * NTH-05 load run and dated report. Runs the seeded conservation simulation at load, a
 * 100-way acceptance contention run, and (with RABBITMQ_URL) a broker replay run, then writes
 * docs/reports/credit-conservation-<date>.{md,json}. Exits non-zero on any violated invariant.
 *
 *   npm run report:conservation            # brings up Compose PostgreSQL and RabbitMQ, then runs this
 *   TEST_POSTGRES_URL=… npm run load -w @foc/system-tests
 *
 * LOAD_SEEDS (count, default 20), LOAD_FIRST_SEED (default 1001), LOAD_STEPS (default 150) and
 * LOAD_USERS (default 10) size the run. The same values reproduce the same seeded sequences.
 */
const defaults: Record<string, string> = {
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
};
for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;

// The services read their configuration at import time, so load them only now.
const { Logger } = await import('@nestjs/common');
Logger.overrideLogger(false); // per-event consumer logs would bury the report's own output
const { runReport } = await import('../src/report.js');
process.exitCode = await runReport();
