import { Module, type DynamicModule } from '@nestjs/common';
import { LOGGER, PgDb, provideDeadLetters, type PgDbOptions } from '@foc/platform';
import { env } from '../config.js';
import { ORDER_DB } from '../db/db.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import { DeadLettersController } from './dead-letters.controller.js';
import { OperationsRepository } from './operations.repository.js';
import {
  CREDIT_STATUS_FETCH,
  CREDIT_STATUS_READER,
  CreditStatusClient,
} from './credit-status.client.js';
import { OrderMetrics } from './order.metrics.js';
import { OrdersController } from './orders.controller.js';
import { OrdersRepository } from './orders.repository.js';
import { OrdersService } from './orders.service.js';
import { SUPPLIER_FETCH, SupplierClient } from './supplier.client.js';

@Module({})
export class OrdersModule {
  static forRoot(): DynamicModule {
    return {
      module: OrdersModule,
      controllers: [OrdersController, AdminOrdersController, DeadLettersController],
      providers: [
        OrdersRepository,
        OrdersService,
        OrderMetrics,
        OperationsRepository,
        // PLT-05: dead letters parked in this service's database; parked only when a broker is set.
        provideDeadLetters({ db: ORDER_DB }),
        SupplierClient,
        { provide: SUPPLIER_FETCH, useValue: fetch },
        CreditStatusClient,
        { provide: CREDIT_STATUS_FETCH, useValue: fetch },
        { provide: CREDIT_STATUS_READER, useExisting: CreditStatusClient },
        {
          provide: ORDER_DB,
          useFactory: (logger: PgDbOptions['logger']) => new PgDb(env.DATABASE_URL, { logger }),
          inject: [LOGGER],
        },
      ],
      exports: [ORDER_DB, OrdersRepository, OrdersService, CREDIT_STATUS_READER],
    };
  }
}
