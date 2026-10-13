import type { Stack } from './stack.js';

/**
 * The closed-economy invariants (ADR 0007, CS-NFR1.1.2, CS-NFR2.1.1), checked against what the
 * services actually stored. Each returns human-readable violations; an empty list means it holds.
 */
export async function economyViolations(stack: Stack): Promise<string[]> {
  const db = stack.creditDb.db;
  const out: string[] = [];

  const wallets = await db.query<{ user_id: string; available: number; reserved: number }>(
    `SELECT user_id, available, reserved FROM wallets`,
  );
  for (const w of wallets.rows) {
    if (!Number.isInteger(w.available) || !Number.isInteger(w.reserved)) {
      out.push(`wallet ${w.user_id} holds a non-integer balance`);
    }
    if (w.available < 0 || w.reserved < 0) out.push(`wallet ${w.user_id} is negative`);
  }

  const unbalanced = await db.query<{ transaction_id: string; debit: string; credit: string }>(
    `SELECT transaction_id,
            sum(amount) FILTER (WHERE direction = 'DEBIT')  AS debit,
            sum(amount) FILTER (WHERE direction = 'CREDIT') AS credit
       FROM ledger_entries GROUP BY transaction_id
     HAVING coalesce(sum(amount) FILTER (WHERE direction = 'DEBIT'), 0)
         <> coalesce(sum(amount) FILTER (WHERE direction = 'CREDIT'), 0)`,
  );
  for (const row of unbalanced.rows) {
    out.push(`transaction ${row.transaction_id} is unbalanced (${row.debit} ≠ ${row.credit})`);
  }

  const totals = await db.query<{ held: string; issued: string }>(
    `SELECT (SELECT coalesce(sum(available + reserved), 0) FROM wallets) AS held,
            (SELECT coalesce(sum(amount), 0) FROM credit_transactions WHERE transaction_type = 'ISSUE') AS issued`,
  );
  const { held, issued } = totals.rows[0]!;
  if (Number(held) !== Number(issued)) {
    out.push(`credits not conserved: wallets hold ${held} but ${issued} were issued`);
  }

  const perOrder = await db.query<{ order_id: string; reserves: string; terminals: string }>(
    `SELECT order_id,
            count(*) FILTER (WHERE transaction_type = 'RESERVE') AS reserves,
            count(*) FILTER (WHERE transaction_type IN ('TRANSFER', 'RELEASE')) AS terminals
       FROM credit_transactions WHERE order_id IS NOT NULL GROUP BY order_id`,
  );
  for (const row of perOrder.rows) {
    if (Number(row.reserves) > 1) out.push(`order ${row.order_id} reserved ${row.reserves} times`);
    if (Number(row.terminals) > 1)
      out.push(`order ${row.order_id} has ${row.terminals} terminal outcomes`);
    if (Number(row.terminals) > 0 && Number(row.reserves) === 0) {
      out.push(`order ${row.order_id} has a terminal outcome without a reservation`);
    }
  }
  return out;
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
