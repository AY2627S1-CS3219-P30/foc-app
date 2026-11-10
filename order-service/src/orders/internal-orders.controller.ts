// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-10-30
// Scope: Generated the initial implementation for "serve the Chat Service's lookup" (NTH-02, #162).
// Author review: Zhang Yuan reviewed the implementation for correctness, ran it against the test
//   suite, and checked that it fits our service boundaries without fatal errors before committing.

import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { ApiException } from '@foc/platform';
import { ServiceKeyGuard } from '../auth/service-key.guard.js';
import { OrdersRepository } from './orders.repository.js';
import { parseOrderId } from './validation.js';

/** Order's internal API, for other services only: hidden on the public port, and keyed. */
@Controller('internal/orders')
@UseGuards(ServiceKeyGuard)
export class InternalOrdersController {
  constructor(@Inject(OrdersRepository) private readonly orders: OrdersRepository) {}

  /** The Chat Service asks this on every request and keeps no copy (ADR 0012). */
  @Get(':id/chat')
  async chat(@Param('id') id: string) {
    const order = await this.orders.findForChat(parseOrderId(id));
    if (!order) throw new ApiException(404, 'NOT_FOUND', 'Order not found.');
    return order;
  }
}
