import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { AdminOnly, CurrentUser, type AuthContext } from '@foc/auth-client';
import { ApiException, DEAD_LETTERS, type DeadLetters } from '@foc/platform';
import type { Request } from 'express';
import { z } from 'zod';
import { env } from '../config.js';
import { OperationsRepository } from './operations.repository.js';
import { OrdersService } from './orders.service.js';
import { parseOrderId, parseResolveOrder } from './validation.js';

const orderIdSchema = z.uuid();

/** Administrator-only: operator views, and decisions on disputes referred to the caller. */
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(OperationsRepository) private readonly operations: OperationsRepository,
    @Inject(DEAD_LETTERS) private readonly deadLetters: DeadLetters,
  ) {}

  /** The most recent reconciliation decisions (CRD-07), newest first. */
  @Get('reconciliation-attempts')
  @AdminOnly()
  reconciliationAttempts() {
    return this.orders.reconciliationAttempts();
  }

  /**
   * Orders that have waited in PENDING_CREDIT longer than CREDIT_WAIT_TIMEOUT_MS. Listing one
   * does not reject it: it still opens if the reservation arrives.
   */
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

  /** Operator alerts (credit waits and conflicts, unreferred disputes) across every errand, newest first. */
  @Get('alerts')
  @AdminOnly()
  alerts() {
    return this.operations.alerts();
  }

  /**
   * PLT-05 (EI-NFR4.1.1) — one errand, from one identifier: its state changes, every event it
   * caused and how sending it went, reconciliation, operator alerts, and any dead letter about it.
   * The Credit Service's half is `GET /admin/orders/{orderId}/credit` there.
   */
  @Get(':orderId/timeline')
  @AdminOnly()
  async timeline(@Param('orderId') orderId: string) {
    if (!orderIdSchema.safeParse(orderId).success) {
      throw new ApiException(400, 'INVALID_ORDER_ID', 'Order ID must be a UUID.');
    }
    const timeline = await this.operations.timeline(orderId);
    if (!timeline) throw new ApiException(404, 'ORDER_NOT_FOUND', 'Order not found.');
    const { items } = await this.deadLetters.list({ q: orderId, page: 1, pageSize: 100 });
    return { ...timeline, deadLetters: items };
  }
}
