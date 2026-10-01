import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Authenticated, CurrentUser, type AuthContext } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { OrdersService } from './orders.service.js';
import { parseAcceptOrder, parseCreateOrder, parseIdempotencyKey } from './validation.js';

const orderIdSchema = z.uuid();

@Controller('orders')
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Get()
  @Authenticated()
  list() {
    return this.orders.listOpen();
  }

  @Get(':id')
  @Authenticated()
  get(
    @Param('id') id: string,
    @Query('view') view: string | undefined,
    @CurrentUser() caller: AuthContext,
  ) {
    const parsed = orderIdSchema.safeParse(id);
    if (!parsed.success)
      throw new ApiException(400, 'INVALID_ORDER_ID', 'Order ID must be a UUID.');
    if (view !== undefined && view !== 'private') {
      throw new ApiException(400, 'INVALID_VIEW', 'View must be private when supplied.');
    }
    return this.orders.getById(parsed.data, caller, view === 'private');
  }

  @Post(':id/accept')
  @Authenticated()
  accept(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    const parsed = orderIdSchema.safeParse(id);
    if (!parsed.success)
      throw new ApiException(400, 'INVALID_ORDER_ID', 'Order ID must be a UUID.');
    const { expectedVersion } = parseAcceptOrder(body);
    return this.orders.accept(
      parsed.data,
      expectedVersion,
      caller,
      request.correlationId ?? 'unknown',
    );
  }

  @Post()
  @Authenticated()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!authorization) {
      throw new ApiException(401, 'TOKEN_MISSING', 'Authorization is required.');
    }
    const result = await this.orders.create(
      parseCreateOrder(body),
      parseIdempotencyKey(rawKey),
      caller,
      authorization,
      request.correlationId ?? 'unknown',
    );
    response.status(result.replayed ? 200 : 201);
    return result.order;
  }
}
