import { Module, type DynamicModule } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { LOGGER, PgDb, type PgDbOptions } from '@foc/platform';
import { AdminController } from '../admin/admin.controller.js';
import { ADMIN_SETTINGS, AdminService, type AdminSettings } from '../admin/admin.service.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { JwksController } from '../auth/jwks.controller.js';
import { JWT, JwtService } from '../auth/jwt.service.js';
import { authRateLimits, createRateLimiters, RATE_LIMITERS } from '../auth/rate-limiter.js';
import { SESSION_SETTINGS, SessionsService } from '../auth/sessions.service.js';
import { SERVICE_KEYS, ServiceKeyGuard } from '../auth/service-key.guard.js';
import { env } from '../config.js';
import { DB, RAW_DB } from '../db/db.js';
import * as schema from '../db/schema.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { MemoryMailbox } from '../mail/memory-mailbox.js';
import { SmtpMailer } from '../mail/smtp-mailer.js';
import { AUTH_COOKIE_SETTINGS, AuthController } from './auth.controller.js';
import { InternalController } from './internal.controller.js';
import { MeController } from './me.controller.js';
import { USER_SETTINGS, UsersService } from './users.service.js';

@Module({})
export class UsersModule {
  static forRoot(): DynamicModule {
    const isProduction = env.NODE_ENV === 'production';
    assertMailConfig(isProduction);

    return {
      module: UsersModule,
      controllers: [
        AuthController,
        InternalController,
        MeController,
        AdminController,
        JwksController,
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
        {
          provide: RATE_LIMITERS,
          useFactory: () =>
            createRateLimiters(
              authRateLimits(
                {
                  loginPerIp: env.LOGIN_LIMIT_PER_IP,
                  loginPerEmail: env.LOGIN_LIMIT_PER_EMAIL,
                  registerPerIp: env.REGISTER_LIMIT_PER_IP,
                },
                isProduction,
              ),
            ),
        },
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
        { provide: MAILER, useFactory: createMailer, inject: [LOGGER] },
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

/**
 * Activation proves the student owns the address only if the token reaches that inbox and nowhere
 * else, so production must deliver real mail. Refuse at boot rather than run without it.
 */
function assertMailConfig(isProduction: boolean): void {
  if (!env.SMTP_HOST) {
    if (isProduction) {
      throw new Error('SMTP_HOST is not set: production must deliver activation email over SMTP.');
    }
    return;
  }
  if (!env.ACTIVATION_URL) {
    throw new Error('ACTIVATION_URL is required with SMTP_HOST: the email links to it.');
  }
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
    throw new Error('Set SMTP_USER and SMTP_PASSWORD together, or neither.');
  }
}

function createMailer(logger: { warn(msg: string): void }): Mailer {
  if (!env.SMTP_HOST) {
    logger.warn('SMTP_HOST is not set: activation email is kept in memory and never delivered.');
    return new MemoryMailbox();
  }
  if (env.NODE_ENV === 'production' && env.SMTP_REQUIRE_TLS === 'false') {
    logger.warn(
      'SMTP_REQUIRE_TLS=false in production: activation links may cross the network in clear.',
    );
  }
  return SmtpMailer.connect(
    {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      requireTls: env.SMTP_REQUIRE_TLS
        ? env.SMTP_REQUIRE_TLS === 'true'
        : env.NODE_ENV === 'production',
    },
    { from: env.MAIL_FROM, activationUrl: env.ACTIVATION_URL! },
  );
}
