import { Module, type DynamicModule } from '@nestjs/common';
import { SERVICE_KEYS, ServiceKeyGuard } from '../auth/service-key.guard.js';
import { env } from '../config.js';
import { DB } from '../db/db.js';
import { PgDb } from '../db/pg-db.js';
import { DevMailbox, DevMailboxController } from '../mail/dev-mailbox.js';
import { MAILER } from '../mail/mailer.js';
import { AuthController } from './auth.controller.js';
import { InternalController } from './internal.controller.js';
import { USER_SETTINGS, UsersService } from './users.service.js';

@Module({})
export class UsersModule {
  static forRoot(): DynamicModule {
    // The dev mailbox exposes activation tokens to anyone who can read it, so it
    // must never run in production. Refuse at boot rather than ship it silently.
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'No production mail adapter is configured: only the development mailbox exists. ' +
          'Implement Mailer for a real provider before running with NODE_ENV=production.',
      );
    }
    const mailbox = new DevMailbox();

    return {
      module: UsersModule,
      controllers: [AuthController, InternalController, DevMailboxController],
      providers: [
        UsersService,
        ServiceKeyGuard,
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
