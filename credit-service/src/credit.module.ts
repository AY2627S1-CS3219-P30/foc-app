import { Module, type DynamicModule } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { LOGGER, PgDb, provideDeadLetters, type PgDbOptions } from '@foc/platform';
import { env } from './config.js';
import { SERVICE_KEYS, ServiceKeyGuard } from './auth/service-key.guard.js';
import { CreditRepository } from './credits/credit.repository.js';
import { AdminCreditController, DeadLettersController } from './credits/operations.controller.js';
import { CreditOperationsRepository } from './credits/operations.repository.js';
import { CreditStatusController } from './credits/status.controller.js';
import { CreditStatusService } from './credits/status.service.js';
import { AdminWalletsController, WalletsController } from './credits/wallets.controller.js';
import { WalletsService } from './credits/wallets.service.js';
import { DB, RAW_DB } from './db/db.js';
import * as schema from './db/schema.js';

@Module({})
export class CreditModule {
  static forRoot(): DynamicModule {
    return {
      module: CreditModule,
      controllers: [
        WalletsController,
        AdminWalletsController,
        CreditStatusController,
        AdminCreditController,
        DeadLettersController,
      ],
      providers: [
        CreditRepository,
        WalletsService,
        CreditStatusService,
        CreditOperationsRepository,
        // PLT-05: parks this service's dead letters once the broker connects, and redrives them.
        provideDeadLetters({ db: RAW_DB }),
        ServiceKeyGuard,
        { provide: SERVICE_KEYS, useValue: env.INTERNAL_SERVICE_KEYS },
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
      ],
      exports: [DB, RAW_DB, CreditRepository, WalletsService, CreditStatusService],
    };
  }
}
