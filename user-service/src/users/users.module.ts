import { Module, type DynamicModule } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { LOGGER, PgDb, type PgDbOptions } from '@foc/platform';
import { AdminController } from '../admin/admin.controller.js';
import { ADMIN_SETTINGS, AdminService, type AdminSettings } from '../admin/admin.service.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { JwksController } from '../auth/jwks.controller.js';
import { JWT, JwtService } from '../auth/jwt.service.js';
import { defaultRateLimiters, RATE_LIMITERS } from '../auth/rate-limiter.js';
import { SESSION_SETTINGS, SessionsService } from '../auth/sessions.service.js';
import { SERVICE_KEYS, ServiceKeyGuard } from '../auth/service-key.guard.js';
import { env } from '../config.js';
import { DB, RAW_DB } from '../db/db.js';
import * as schema from '../db/schema.js';
import { DevMailbox, DevMailboxController } from '../mail/dev-mailbox.js';
import { MAILER } from '../mail/mailer.js';
import { AUTH_COOKIE_SETTINGS, AuthController } from './auth.controller.js';
import { InternalController } from './internal.controller.js';
import { MeController } from './me.controller.js';
import { USER_SETTINGS, UsersService } from './users.service.js';

@Module({})
export class UsersModule {
  static forRoot(): DynamicModule {
    // The dev mailbox exposes activation tokens to anyone who can read it, so it
    // must never run in production. Refuse at boot rather than ship it silently.
    const isProduction = env.NODE_ENV === 'production';
    if (isProduction) {
      throw new Error(
        'No production mail adapter is configured: only the development mailbox exists. ' +
          'Implement Mailer for a real provider before running with NODE_ENV=production.',
      );
    }
    const mailbox = new DevMailbox();

    return {
      module: UsersModule,
      controllers: [
        AuthController,
        InternalController,
        MeController,
        AdminController,
        JwksController,
        DevMailboxController,
      ],
      providers: [
        UsersService,
        SessionsService,
        AdminService,
        AdminGuard,
        ServiceKeyGuard,
        AccessTokenGuard,
        {
          provide: JWT,
          useFactory: () => JwtService.create(env.JWT_PRIVATE_KEY, !isProduction),
        },
        { provide: RATE_LIMITERS, useFactory: defaultRateLimiters },
        {
          provide: ADMIN_SETTINGS,
          useValue: {
            roleRequestTtlHours: env.ROLE_REQUEST_TTL_HOURS,
            stepUpWindowSeconds: env.STEP_UP_WINDOW_SECONDS,
            suspensionsAlertPerHour: env.ADMIN_SUSPENSIONS_ALERT_PER_HOUR,
            suspensionsLimitPerHour: env.ADMIN_SUSPENSIONS_LIMIT_PER_HOUR,
            readsAlertPerHour: env.ADMIN_READS_ALERT_PER_HOUR,
          } satisfies AdminSettings,
        },
        {
          provide: AUTH_COOKIE_SETTINGS,
          useValue: {
            secure: isProduction,
            // CORS_ORIGINS is load-bearing for CSRF: these origins may drive login, refresh and
            // logout. Do not widen it (previews, dashboards) without weighing that.
            allowedOrigins: env.CORS_ORIGINS.split(',')
              .map((o) => o.trim())
              .filter(Boolean),
          },
        },
        {
          provide: RAW_DB,
          useFactory: (logger: PgDbOptions['logger']) => new PgDb(env.DATABASE_URL, { logger }),
          inject: [LOGGER],
        },
        {
          provide: DB,
          useFactory: (raw: PgDb) => drizzle(raw.pool, { schema }),
          inject: [RAW_DB],
        },
        { provide: MAILER, useValue: mailbox },
        { provide: DevMailbox, useValue: mailbox },
        { provide: SERVICE_KEYS, useValue: env.INTERNAL_SERVICE_KEYS },
        {
          provide: USER_SETTINGS,
          useValue: {
            allowedEmailDomains: env.ALLOWED_EMAIL_DOMAINS,
            activationTokenTtlHours: env.ACTIVATION_TOKEN_TTL_HOURS,
          },
        },
        { provide: SESSION_SETTINGS, useValue: { bootstrapPassword: env.ADMIN_SEED_PASSWORD } },
      ],
      exports: [DB, RAW_DB, UsersService],
    };
  }
}
