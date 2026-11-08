// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5, Claude Opus 4.8, Claude Opus 5, Claude Sonnet 5), dates:
//   2026-09-20 to 2026-10-13
// Scope: Generated the initial implementation for "scaffold the four services on a shared runtime"
//   (USR-01, #188, PLT-06); later new features, refactoring and bug fixes.
// Author review: Patrick Thomas, Jonus Ho and Anselm Long validated correctness and the
//   implementation, and checked for fatal errors and architectural conflicts, before committing.

export { baseEnvSchema, loadEnv, type BaseEnv } from './env.js';
export {
  CORRELATION_HEADER,
  CAUSATION_HEADER,
  echoCorrelationId,
  resolveCorrelationId,
} from './correlation.js';
export { createLogger, errorMessage, PinoLoggerService, requestLogger } from './logging.js';
export { ApiException, ErrorEnvelopeFilter, type ErrorEnvelope } from './errors.js';
export {
  HEALTH_INDICATORS,
  HealthController,
  SERVICE_INFO,
  isHealthIndicator,
  type HealthIndicator,
  type HealthResponse,
  type ServiceInfo,
} from './health.controller.js';
export { LOGGER, PlatformModule, type PlatformModuleOptions } from './platform.module.js';
export {
  METRICS,
  Metrics,
  MetricsController,
  UNMEASURED_PATHS,
  type GaugeSetter,
} from './metrics.js';
export { startService } from './bootstrap.js';
export {
  escapeLike,
  PgDb,
  type Db,
  type DrizzleDatabase,
  type PgDbOptions,
  type Queryable,
  type Row,
} from './db.js';
export { assertJournalOrdered, runDrizzleMigrations } from './migrations.js';
export * from './events/index.js';
