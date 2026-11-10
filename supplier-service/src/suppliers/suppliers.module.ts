// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 4.8, Claude Opus 5.5), dates: 2026-09-28 to 2026-10-01
// Scope: Generated the initial implementation for "SUP-01: supplier schema, admin CRUD, and
//   idempotent seed" (SUP-01, #188); later refactoring, new features and bug fixes.
// Author review: Patrick Thomas and Jonus Ho reviewed the implementation for correctness, ran it
//   against the test suite, and checked that it fits our service boundaries without fatal errors
//   before committing.

import { Module, type DynamicModule } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { LOGGER, PgDb, type PgDbOptions } from '@foc/platform';
import { env } from '../config.js';
import { DB, RAW_DB } from '../db/db.js';
import * as schema from '../db/schema.js';
import { BuildingsController } from './buildings.controller.js';
import { SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

@Module({})
export class SuppliersModule {
  static forRoot(): DynamicModule {
    return {
      module: SuppliersModule,
      controllers: [SuppliersController, BuildingsController],
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
      exports: [DB, SuppliersService],
    };
  }
}
