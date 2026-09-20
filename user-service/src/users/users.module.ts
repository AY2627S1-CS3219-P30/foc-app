import { Module, type DynamicModule } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { JwksController } from '../auth/jwks.controller.js';
import { JWT, JwtService } from '../auth/jwt.service.js';
import { defaultRateLimiters, RATE_LIMITERS } from '../auth/rate-limiter.js';
import { SessionsService } from '../auth/sessions.service.js';
import { SERVICE_KEYS, ServiceKeyGuard } from '../auth/service-key.guard.js';
import { env } from '../config.js';
import { DB } from '../db/db.js';
import { PgDb } from '../db/pg-db.js';
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
        JwksController,
        DevMailboxController,
      ],
      providers: [
        UsersService,
        SessionsService,
        ServiceKeyGuard,
        AccessTokenGuard,
        {
          provide: JWT,
          useFactory: () => JwtService.create(env.JWT_PRIVATE_KEY, !isProduction),
        },
        { provide: RATE_LIMITERS, useFactory: defaultRateLimiters },
        {
          provide: AUTH_COOKIE_SETTINGS,
          useValue: {
            secure: isProduction,
            allowedOrigins: env.CORS_ORIGINS.split(',')
              .map((o) => o.trim())
              .filter(Boolean),
          },
        },
        { provide: DB, useFactory: () => new PgDb(env.DATABASE_URL) },
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
      ],
      exports: [DB, UsersService],
    };
  }
}
