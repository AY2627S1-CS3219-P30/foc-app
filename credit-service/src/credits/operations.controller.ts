import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { AdminOnly, CurrentUser, type AuthContext, type AuthedRequest } from '@foc/auth-client';
import {
  ApiException,
  DEAD_LETTERS,
  parseDeadLetterId,
  parseDeadLetterQuery,
  parseRedriveReason,
  type DeadLetters,
} from '@foc/platform';
import { z } from 'zod';
import { AdminActivity } from './admin-activity.js';
import { CreditOperationsRepository } from './operations.repository.js';

const orderIdSchema = z.uuid();

type CorrelatedRequest = AuthedRequest & { correlationId?: string; id?: string };

/** Operator views of Credit (PLT-05, ADM-04). Administrator-only; they read and never move credit. */
@Controller('admin')
export class AdminCreditController {
  constructor(
    @Inject(CreditOperationsRepository) private readonly operations: CreditOperationsRepository,
    @Inject(DEAD_LETTERS) private readonly deadLetters: DeadLetters,
    @Inject(AdminActivity) private readonly activity: AdminActivity,
  ) {}

  /**
   * Credit's half of one errand's trace (EI-NFR4.1.1): what it decided, the transactions that made,
   * its audit alerts, and any of its dead letters about the errand. Empty lists mean Credit has no
   * record of it, which is itself the answer when a request never arrived.
   */
  @Get('orders/:orderId/credit')
  @AdminOnly()
  async orderCredit(@Param('orderId') orderId: string) {
    if (!orderIdSchema.safeParse(orderId).success) {
      throw new ApiException(400, 'INVALID_ORDER_ID', 'Order ID must be a UUID.');
    }
    const credit = await this.operations.orderCredit(orderId);
    const { items } = await this.deadLetters.list({ q: orderId, page: 1, pageSize: 100 });
    return { ...credit, deadLetters: items };
  }

  /** Credit's audit alerts across every errand, newest first. */
  @Get('credit-alerts')
  @AdminOnly()
  alerts() {
    return this.operations.alerts();
  }

  /** ADM-04: alerts about administrators here (BULK_WALLET_READS), newest first. */
  @Get('activity-alerts')
  @AdminOnly()
  activityAlerts() {
    return this.activity.alerts();
  }
}

/**
 * PLT-05 (EI-FR3.1.2) — Credit's dead letters: `user.activated` and Order's credit requests that
 * failed every retry. A redrive delivers the stored message, unchanged, to the queue it failed on,
 * where the normal consumer and its inbox decide again; the route itself moves no credit.
 */
@Controller('admin/dead-letters')
export class DeadLettersController {
  constructor(@Inject(DEAD_LETTERS) private readonly letters: DeadLetters) {}

  @Get()
  @AdminOnly()
  list(@Query() query: unknown) {
    return this.letters.list(parseDeadLetterQuery(query));
  }

  @Get(':id')
  @AdminOnly()
  get(@Param('id') id: string) {
    return this.letters.get(parseDeadLetterId(id));
  }

  @Post(':id/redrive')
  @HttpCode(200)
  @AdminOnly()
  redrive(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: CorrelatedRequest,
  ) {
    return this.letters.redrive(parseDeadLetterId(id), {
      actorId: caller.userId,
      reason: parseRedriveReason(body),
      correlationId: request.correlationId ?? request.id ?? 'unknown',
    });
  }
}
