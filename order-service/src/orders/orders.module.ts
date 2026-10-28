import { Module, type DynamicModule } from '@nestjs/common';
import { LOGGER, PgDb, provideDeadLetters, type PgDbOptions } from '@foc/platform';
import { env } from '../config.js';
import { ORDER_DB } from '../db/db.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import { DeadLettersController } from './dead-letters.controller.js';
import { LIVE_OPTIONS, LiveHub, type LiveOptions } from './live/live-hub.js';
import { LiveController } from './live/live.controller.js';
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
import { USER_DIRECTORY_FETCH, UserDirectoryClient } from './user-directory.client.js';

/** N1.4: the switch and lifetime are configured; the limits are the design's (#329). */
const liveOptions: LiveOptions = {
  enabled: env.LIVE_UPDATES_ENABLED,
  maxStreamMs: env.LIVE_STREAM_MAX_MS,
  perUser: 5,
  perInstance: 1_000,
  keepAliveMs: 20_000,
  boardIntervalMs: 1_000,
};

@Module({})
export class OrdersModule {
  static forRoot(): DynamicModule {
    return {
      module: OrdersModule,
      controllers: [OrdersController, AdminOrdersController, DeadLettersController, LiveController],
      providers: [
        OrdersRepository,
        OrdersService,
        OrderMetrics,
        OperationsRepository,
        LiveHub,
        { provide: LIVE_OPTIONS, useValue: liveOptions },
        // PLT-05: dead letters parked in this service's database; parked only when a broker is set.
        provideDeadLetters({ db: ORDER_DB }),
        SupplierClient,
        { provide: SUPPLIER_FETCH, useValue: fetch },
        CreditStatusClient,
        { provide: CREDIT_STATUS_FETCH, useValue: fetch },
        { provide: CREDIT_STATUS_READER, useExisting: CreditStatusClient },
        UserDirectoryClient,
        { provide: USER_DIRECTORY_FETCH, useValue: fetch },
        {
          provide: ORDER_DB,
          useFactory: (logger: PgDbOptions['logger']) => new PgDb(env.DATABASE_URL, { logger }),
          inject: [LOGGER],
        },
      ],
      exports: [
        ORDER_DB,
        OrdersRepository,
        OrdersService,
        LiveHub,
        CREDIT_STATUS_READER,
        UserDirectoryClient,
      ],
    };
  }
}
