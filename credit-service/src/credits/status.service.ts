import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '@foc/platform';
import { z } from 'zod';
import { CreditRepository } from './credit.repository.js';
import type { OrderCreditStatus } from './types.js';

const orderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

@Injectable()
export class CreditStatusService {
  constructor(@Inject(CreditRepository) private readonly credits: CreditRepository) {}

  status(orderIdValue: string): Promise<OrderCreditStatus> {
    const parsed = orderIdSchema.safeParse(orderIdValue);
    if (!parsed.success) {
      throw new ApiException(400, 'INVALID_ORDER_ID', 'The order identifier is invalid.');
    }
    return this.credits.orderStatus(parsed.data);
  }
}
