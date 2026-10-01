import { Controller, Get, Inject } from '@nestjs/common';
import { AdminOnly } from '@foc/auth-client';
import { env } from '../config.js';
import { OrdersService } from './orders.service.js';

/** Operator views. Administrator-only; they read but never change an order. */
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  /**
   * Orders that have waited in PENDING_CREDIT longer than CREDIT_WAIT_TIMEOUT_MS. Listing one
   * does not reject it: it still opens if the reservation arrives.
   */
  @Get('pending-credit')
  @AdminOnly()
  pendingCredit() {
    return this.orders.creditWaitExceeded(env.CREDIT_WAIT_TIMEOUT_MS);
  }
}
