import { Module, type DynamicModule } from '@nestjs/common';
import { env } from '../config.js';
import { DB } from '../db/db.js';
import { PgDb } from '../db/pg-db.js';
import { SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

@Module({})
export class SuppliersModule {
  static forRoot(): DynamicModule {
    return {
      module: SuppliersModule,
      controllers: [SuppliersController],
      providers: [SuppliersService, { provide: DB, useFactory: () => new PgDb(env.DATABASE_URL) }],
      exports: [DB, SuppliersService],
    };
  }
}
