import { Controller, Get, Inject, Param } from '@nestjs/common';
import { Authenticated, CurrentUser, type AuthContext } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import { z } from 'zod';
import { OrdersService } from './orders.service.js';

const orderIdSchema = z.uuid();

@Controller('orders')
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Get(':id')
  @Authenticated()
  get(@Param('id') id: string, @CurrentUser() caller: AuthContext) {
    const parsed = orderIdSchema.safeParse(id);
    if (!parsed.success)
      throw new ApiException(400, 'INVALID_ORDER_ID', 'Order ID must be a UUID.');
    return this.orders.getById(parsed.data, caller);
  }
}
