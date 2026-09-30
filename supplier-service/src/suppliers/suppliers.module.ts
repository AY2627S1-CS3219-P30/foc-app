import { Module, type DynamicModule } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { LOGGER, PgDb, type PgDbOptions } from '@foc/platform';
import { env } from '../config.js';
import { DB, RAW_DB } from '../db/db.js';
import * as schema from '../db/schema.js';
import { SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

@Module({})
export class SuppliersModule {
  static forRoot(): DynamicModule {
    return {
      module: SuppliersModule,
      controllers: [SuppliersController],
      providers: [
        SuppliersService,
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
      exports: [DB, RAW_DB, SuppliersService],
    };
  }
}
