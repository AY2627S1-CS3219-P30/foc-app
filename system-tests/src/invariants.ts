import { creditEconomyViolations } from '../../credit-service/src/credits/invariants.js';
import type { Stack } from './stack.js';

/**
 * The closed-economy invariants (ADR 0007, CS-NFR1.1.2, CS-NFR2.1.1), checked against what the
 * Credit Service actually stored. They are stated once, in the Credit Service
 * (`credit-service/src/credits/invariants.ts`), so this suite, its unit tests and the live check
 * cannot drift apart.
 */
export async function economyViolations(stack: Stack): Promise<string[]> {
  return creditEconomyViolations(stack.creditDb.db);
}

/** What Credit must have recorded for an order Order shows in each settled state. */
const EXPECTED: Record<string, string[][]> = {
  PENDING_CREDIT: [[], ['RESERVE']],
  REJECTED: [[]],
  OPEN: [['RESERVE']],
  ACCEPTED: [['RESERVE']],
  PICKED_UP: [['RESERVE']],
  DELIVERED: [['RESERVE']],
  COMPLETION_PENDING_CREDIT: [['RESERVE'], ['RESERVE', 'TRANSFER']],
  RELEASE_PENDING_CREDIT: [['RESERVE'], ['RESERVE', 'RELEASE']],
  COMPLETED: [['RESERVE', 'TRANSFER']],
  CANCELLED: [['RESERVE', 'RELEASE']],
  EXPIRED: [['RESERVE', 'RELEASE']],
};

/**
 * Cross-service agreement. With `settled`, nothing is in flight, so every waiting state must have
 * been resolved: Order and Credit agree exactly, and no order is left waiting on Credit.
 */
export async function agreementViolations(stack: Stack, settled: boolean): Promise<string[]> {
  const out: string[] = [];
  const orders = await stack.orderDb.db.query<{ order_id: string; status: string }>(
    `SELECT order_id, status FROM orders WHERE order_id <> '00000000-0000-4000-8000-000000000129'`,
  );
  for (const { order_id, status } of orders.rows) {
    const types = await stack.transactionsFor(order_id);
    const allowed = EXPECTED[status] ?? [];
    if (!allowed.some((expected) => expected.join() === types.join())) {
      out.push(`order ${order_id} is ${status} but Credit recorded [${types.join(', ')}]`);
    }
    if (settled && status.endsWith('_PENDING_CREDIT')) {
      out.push(`order ${order_id} is still ${status} after settling`);
    }
    if (settled && status === 'PENDING_CREDIT')
      out.push(`order ${order_id} never got a reservation answer`);
  }
  return [...new Set(out)];
}
