import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
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
import type { OrderAction } from './order-state-machine.js';
import { parseAcceptOrder, parseCreateOrder, parseIdempotencyKey } from './validation.js';

const orderIdSchema = z.uuid();

const parseOrderId = (id: string): string => {
  const parsed = orderIdSchema.safeParse(id);
  if (!parsed.success) throw new ApiException(400, 'INVALID_ORDER_ID', 'Order ID must be a UUID.');
  return parsed.data;
};

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

  @Get(':id/history')
  @Authenticated()
  history(@Param('id') id: string, @CurrentUser() caller: AuthContext) {
    return this.orders.history(parseOrderId(id), caller);
  }

  @Get(':id/receipt')
  @Authenticated()
  receipt(@Param('id') id: string, @CurrentUser() caller: AuthContext) {
    return this.orders.receipt(parseOrderId(id), caller);
  }

  @Post(':id/pickup')
  @HttpCode(200)
  @Authenticated()
  pickup(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    return this.run(id, 'RECORD_PICKUP', body, caller, request);
  }

  @Post(':id/deliver')
  @HttpCode(200)
  @Authenticated()
  deliver(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    return this.run(id, 'RECORD_DELIVERY', body, caller, request);
  }

  @Post(':id/confirm-receipt')
  @HttpCode(200)
  @Authenticated()
  confirmReceipt(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    return this.run(id, 'CONFIRM_RECEIPT', body, caller, request);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Authenticated()
  cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    return this.run(id, 'CANCEL', body, caller, request);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Authenticated()
  withdraw(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    return this.run(id, 'WITHDRAW', body, caller, request);
  }

  private run(
    id: string,
    action: OrderAction,
    body: unknown,
    caller: AuthContext,
    request: Request & { correlationId?: string },
  ) {
    const orderId = parseOrderId(id);
    const { expectedVersion } = parseAcceptOrder(body);
    return this.orders.command(
      orderId,
      action,
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
