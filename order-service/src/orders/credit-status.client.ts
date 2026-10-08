import { Inject, Injectable } from '@nestjs/common';
import { CORRELATION_HEADER } from '@foc/platform';
import { z } from 'zod';
import { env } from '../config.js';

/** Credit's authoritative view of one order (CRD-06), as reconciliation reads it. */
export const creditStatusSchema = z.object({
  orderId: z.string(),
  status: z.enum(['NONE', 'RESERVED', 'RELEASED', 'TRANSFERRED']),
  detail: z.enum(['UNKNOWN', 'IN_FLIGHT', 'REJECTED']).nullable(),
});
export type CreditStatus = z.infer<typeof creditStatusSchema>;

export interface CreditStatusReader {
  /** `correlationId` travels on the call, so Credit logs it under the same ID (PLT-04). */
  status(orderId: string, correlationId?: string): Promise<CreditStatus>;
}

/** The reader reconciliation uses; tests and system tests substitute their own. */
export const CREDIT_STATUS_READER = Symbol('CREDIT_STATUS_READER');
export const CREDIT_STATUS_FETCH = Symbol('CREDIT_STATUS_FETCH');

export class CreditUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditUnavailableError';
  }
}

/**
 * Reads `GET /internal/orders/{orderId}/credit-status` with this service's own credential, which
 * Credit must list in its INTERNAL_SERVICE_KEYS (ADR 0004). Any failure — unreachable, non-200,
 * unexpected body — is CreditUnavailableError: reconciliation then repairs nothing.
 */
@Injectable()
export class CreditStatusClient implements CreditStatusReader {
  constructor(@Inject(CREDIT_STATUS_FETCH) private readonly fetchFn: typeof fetch) {}

  async status(orderId: string, correlationId?: string): Promise<CreditStatus> {
    let response: Response;
    try {
      response = await this.fetchFn(
        `${env.CREDIT_SERVICE_URL}/internal/orders/${encodeURIComponent(orderId)}/credit-status`,
        {
          headers: {
            'X-Service-Key': env.INTERNAL_SERVICE_KEY,
            ...(correlationId ? { [CORRELATION_HEADER]: correlationId } : {}),
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch (error) {
      throw new CreditUnavailableError(`Credit status unreachable: ${String(error)}`);
    }
    if (!response.ok) {
      throw new CreditUnavailableError(`Credit status answered ${response.status}`);
    }
    const parsed = creditStatusSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success || parsed.data.orderId !== orderId) {
      throw new CreditUnavailableError('Credit status body did not match the contract');
    }
    return parsed.data;
  }
}

/**
 * What reconciliation may do for an order stuck waiting on Credit, given Credit's own record.
 * Re-issuing the original request is always safe: Credit applies each operation at most once per
 * order and answers a repeat with the recorded result. Any other combination means the two
 * services disagree about money and needs a person.
 */
export function reconciliationDecision(
  orderStatus: 'PENDING_CREDIT' | 'COMPLETION_PENDING_CREDIT' | 'RELEASE_PENDING_CREDIT',
  credit: CreditStatus['status'],
): 'REISSUE' | 'ALERT' {
  const repairable = {
    PENDING_CREDIT: ['NONE', 'RESERVED'],
    COMPLETION_PENDING_CREDIT: ['RESERVED', 'TRANSFERRED'],
    RELEASE_PENDING_CREDIT: ['RESERVED', 'RELEASED'],
  } as const;
  return (repairable[orderStatus] as readonly string[]).includes(credit) ? 'REISSUE' : 'ALERT';
}
