import { Module, type DynamicModule } from '@nestjs/common';
import { LOGGER, PgDb, type PgDbOptions } from '@foc/platform';
import { env } from '../config.js';
import { DB } from '../db/db.js';
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
          provide: DB,
          useFactory: (logger: PgDbOptions['logger']) => new PgDb(env.DATABASE_URL, { logger }),
          inject: [LOGGER],
        },
      ],
      exports: [DB, SuppliersService],
    };
  }
}
