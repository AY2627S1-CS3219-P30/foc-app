import { Module, type DynamicModule } from '@nestjs/common';
import { LOGGER, PgDb, type PgDbOptions } from '@foc/platform';
import { env } from '../config.js';
import { ORDER_DB } from '../db/db.js';
import { OrdersController } from './orders.controller.js';
import { OrdersRepository } from './orders.repository.js';
import { OrdersService } from './orders.service.js';
import { SUPPLIER_FETCH, SupplierClient } from './supplier.client.js';

@Module({})
export class OrdersModule {
  static forRoot(): DynamicModule {
    return {
      module: OrdersModule,
      controllers: [OrdersController],
      providers: [
        OrdersRepository,
        OrdersService,
        SupplierClient,
        { provide: SUPPLIER_FETCH, useValue: fetch },
        {
          provide: ORDER_DB,
          useFactory: (logger: PgDbOptions['logger']) => new PgDb(env.DATABASE_URL, { logger }),
          inject: [LOGGER],
        },
      ],
      exports: [ORDER_DB, OrdersRepository, OrdersService],
    };
  }
}
