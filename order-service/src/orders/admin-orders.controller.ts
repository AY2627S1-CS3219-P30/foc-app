import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { AdminOnly, CurrentUser, type AuthContext } from '@foc/auth-client';
import type { Request } from 'express';
import { env } from '../config.js';
import { OrdersService } from './orders.service.js';
import { parseOrderId, parseResolveOrder } from './validation.js';

/** Administrator-only: operator views, and decisions on disputes referred to the caller. */
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  /**
   * Orders that have waited in PENDING_CREDIT longer than CREDIT_WAIT_TIMEOUT_MS. Listing one
   * does not reject it: it still opens if the reservation arrives.
   */
  /** The most recent reconciliation decisions (CRD-07), newest first. */
  @Get('reconciliation-attempts')
  @AdminOnly()
  reconciliationAttempts() {
    return this.orders.reconciliationAttempts();
  }

  @Get('pending-credit')
  @AdminOnly()
  pendingCredit() {
    return this.orders.creditWaitExceeded(env.CREDIT_WAIT_TIMEOUT_MS);
  }

  /** Disputes referred to the caller, and those not yet referred to anyone. */
  @Get('referred')
  @AdminOnly()
  referred(@CurrentUser() caller: AuthContext) {
    return this.orders.referred(caller);
  }

  /** The most recent dispute decisions, newest first. */
  @Get('decisions')
  @AdminOnly()
  decisions() {
    return this.orders.decisions();
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @AdminOnly()
  resolve(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    return this.orders.resolve(
      parseOrderId(id),
      parseResolveOrder(body),
      caller,
      request.correlationId ?? 'unknown',
    );
  }
}
