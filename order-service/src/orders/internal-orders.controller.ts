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
