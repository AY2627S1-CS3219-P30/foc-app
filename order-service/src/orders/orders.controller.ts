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
import { OrdersService } from './orders.service.js';
import type { OrderAction } from './order-state-machine.js';
import {
  parseAcceptOrder,
  parseCreateOrder,
  parseIdempotencyKey,
  parseMyOrdersQuery,
  parseOpenOrdersQuery,
  parseOrderId,
} from './validation.js';

export const NEXT_CURSOR_HEADER = 'Next-Cursor';

@Controller('orders')
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  /** The body stays the bare array it has always been; the next page's cursor is a header. */
  @Get()
  @Authenticated()
  async list(
    @Query() query: unknown,
    @CurrentUser() caller: AuthContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { items, nextCursor } = await this.orders.listOpen(
      caller.userId,
      parseOpenOrdersQuery(query),
    );
    if (nextCursor) response.setHeader(NEXT_CURSOR_HEADER, nextCursor);
    return items;
  }

  // Declared before ':id', which would otherwise refuse "mine" as an invalid order ID.
  @Get('mine')
  @Authenticated()
  listMine(@Query() query: unknown, @CurrentUser() caller: AuthContext) {
    return this.orders.listMine(caller, parseMyOrdersQuery(query));
  }

  @Get(':id')
  @Authenticated()
  get(
    @Param('id') id: string,
    @Query('view') view: string | undefined,
    @CurrentUser() caller: AuthContext,
  ) {
    const orderId = parseOrderId(id);
    if (view !== undefined && view !== 'private') {
      throw new ApiException(400, 'INVALID_VIEW', 'View must be private when supplied.');
    }
    return this.orders.getById(orderId, caller, view === 'private');
  }

  @Post(':id/accept')
  @Authenticated()
  accept(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    const orderId = parseOrderId(id);
    const { expectedVersion } = parseAcceptOrder(body);
    return this.orders.accept(orderId, expectedVersion, caller, request.correlationId ?? 'unknown');
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

  @Post(':id/report-non-delivery')
  @HttpCode(200)
  @Authenticated()
  reportNonDelivery(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    return this.run(id, 'REPORT_NON_DELIVERY', body, caller, request);
  }

  @Post(':id/report-non-receipt')
  @HttpCode(200)
  @Authenticated()
  reportNonReceipt(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    return this.run(id, 'REPORT_NON_RECEIPT', body, caller, request);
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
