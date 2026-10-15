import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/pglite';
import type { DestinationStream } from 'pino';
import { ErrorEnvelopeFilter, LOGGER, PinoLoggerService, PlatformModule } from '@foc/platform';
import { ADMIN_SETTINGS, type AdminSettings } from '../../src/admin/admin.service.js';
import { RATE_LIMITERS, RateLimiter, type AuthRateLimiters } from '../../src/auth/rate-limiter.js';
import { DB, RAW_DB, type Database } from '../../src/db/db.js';
import * as schema from '../../src/db/schema.js';
import { DevMailbox } from '../../src/mail/dev-mailbox.js';
import { UsersModule } from '../../src/users/users.module.js';
import { applyMigrations } from './migrate.js';
import { PgliteDb } from './pglite-db.js';

export const SERVICE_KEY = 'test-internal-key-0123456789';

export interface TestApp {
  app: INestApplication;
  /** The raw port, for direct SQL assertions. */
  db: PgliteDb;
  /** The Drizzle handle the service queries through, for driving a repository or the seed directly. */
  orm: Database;
  mailbox: DevMailbox;
  close(): Promise<void>;
}

/** Boots the real modules against an in-memory PostgreSQL with migrations applied. */
export async function createTestApp(
  options: {
    logLevel?: string;
    logDestination?: DestinationStream;
    rateLimiters?: AuthRateLimiters;
    /** Overrides for the controls on administrators (ADR 0008), e.g. a lower alert threshold. */
    adminSettings?: Partial<AdminSettings>;
    /** An existing PGlite to reuse; migrations are applied idempotently. */
    db?: PgliteDb;
  } = {},
): Promise<TestApp> {
  const db = options.db ?? (await PgliteDb.create());
  await applyMigrations(db);
  const orm = drizzle(db.client, { schema });

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot({
        serviceName: 'user-service',
        version: 'test',
        logLevel: options.logLevel ?? 'silent',
        logDestination: options.logDestination,
      }),
      UsersModule.forRoot(),
    ],
  })
    .overrideProvider(RAW_DB)
    .useValue(db)
    .overrideProvider(DB)
    .useValue(orm)
    // Generous by default: the suite shares one client IP and registers far more than a person would.
    .overrideProvider(RATE_LIMITERS)
    .useValue(options.rateLimiters ?? openLimiters())
    .overrideProvider(ADMIN_SETTINGS)
    .useValue({ ...DEFAULT_ADMIN_SETTINGS, ...options.adminSettings })
    .compile();

  // A suite that captures logs gets main.ts's wiring: Nest's own Logger (the error filter, any
  // service) writes through the platform's pino instance, so the log-privacy scan sees everything
  // production would log. Nest installs an app's logger process-wide, so the others keep Nest's
  // console default and an unexpected 500 still prints.
  const app = moduleRef.createNestApplication(
    options.logDestination ? { logger: new PinoLoggerService(moduleRef.get(LOGGER)) } : {},
  );
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  // Listen once so concurrent supertest requests share one server instead of racing to start it.
  await app.listen(0);

  return {
    app,
    db,
    orm,
    mailbox: app.get(DevMailbox),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export const validRegistration = (email = 'e0123456@u.nus.edu') => ({
  email,
  password: 'correct-horse-battery-staple',
  displayName: 'Alex Tan',
});

/** ADR 0008's defaults, as `config.ts` would supply them. */
export const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  roleRequestTtlHours: 24,
  stepUpWindowSeconds: 300,
  suspensionsAlertPerHour: 10,
  suspensionsLimitPerHour: 20,
  readsAlertPerHour: 50,
};

export const openLimiters = (): AuthRateLimiters => ({
  loginPerEmail: new RateLimiter(1_000_000, 60_000),
  loginPerIp: new RateLimiter(1_000_000, 60_000),
  registerPerIp: new RateLimiter(1_000_000, 60_000),
  stepUpPerUser: new RateLimiter(1_000_000, 60_000),
});
