import type { Queryable, Row } from '@foc/platform';

/**
 * The closed-economy invariants (ADR 0007, CS-NFR1.1.2, CS-NFR2.1.1), checked against what the
 * Credit Service actually stored. Each check returns human-readable violations; an empty list means
 * it holds. All are read-only: they report a mismatch and change nothing.
 *
 * This is the one statement of them. The cross-service suite runs them after every generated
 * sequence (`system-tests/src/invariants.ts`), and `check-invariants.ts` runs them against a live
 * database for the walkthrough and the failure demo.
 */
export type CreditInvariant = (queryable: Queryable) => Promise<string[]>;

/** No wallet is negative or fractional. */
export const balanceViolations: CreditInvariant = async (queryable) => {
  const wallets = await queryable.query<
    Row & { user_id: string; available: number; reserved: number }
  >(`SELECT user_id, available, reserved FROM wallets`);
  const out: string[] = [];
  for (const w of wallets.rows) {
    if (!Number.isInteger(w.available) || !Number.isInteger(w.reserved)) {
      out.push(`wallet ${w.user_id} holds a non-integer balance`);
    }
    if (w.available < 0 || w.reserved < 0) out.push(`wallet ${w.user_id} is negative`);
  }
  return out;
};

/** Every transaction's debits equal its credits. */
export const unbalancedTransactionViolations: CreditInvariant = async (queryable) => {
  const unbalanced = await queryable.query<
    Row & { transaction_id: string; debit: string | null; credit: string | null }
  >(
    `SELECT transaction_id,
            sum(amount) FILTER (WHERE direction = 'DEBIT')  AS debit,
            sum(amount) FILTER (WHERE direction = 'CREDIT') AS credit
       FROM ledger_entries GROUP BY transaction_id
     HAVING coalesce(sum(amount) FILTER (WHERE direction = 'DEBIT'), 0)
         <> coalesce(sum(amount) FILTER (WHERE direction = 'CREDIT'), 0)`,
  );
  return unbalanced.rows.map(
    (row) => `transaction ${row.transaction_id} is unbalanced (${row.debit} ≠ ${row.credit})`,
  );
};

/** All wallets together hold exactly what was issued: credits change only at issuance. */
export const conservationViolations: CreditInvariant = async (queryable) => {
  const totals = await queryable.query<Row & { held: string; issued: string }>(
    `SELECT (SELECT coalesce(sum(available + reserved), 0) FROM wallets) AS held,
            (SELECT coalesce(sum(amount), 0) FROM credit_transactions WHERE transaction_type = 'ISSUE') AS issued`,
  );
  const { held, issued } = totals.rows[0]!;
  return Number(held) === Number(issued)
    ? []
    : [`credits not conserved: wallets hold ${held} but ${issued} were issued`];
};

/** Each order is reserved at most once and settles at most once, never without a reservation. */
export const orderOutcomeViolations: CreditInvariant = async (queryable) => {
  const perOrder = await queryable.query<
    Row & { order_id: string; reserves: string; terminals: string }
  >(
    `SELECT order_id,
            count(*) FILTER (WHERE transaction_type = 'RESERVE') AS reserves,
            count(*) FILTER (WHERE transaction_type IN ('TRANSFER', 'RELEASE')) AS terminals
       FROM credit_transactions WHERE order_id IS NOT NULL GROUP BY order_id`,
  );
  const out: string[] = [];
  for (const row of perOrder.rows) {
    if (Number(row.reserves) > 1) out.push(`order ${row.order_id} reserved ${row.reserves} times`);
    if (Number(row.terminals) > 1) {
      out.push(`order ${row.order_id} has ${row.terminals} terminal outcomes`);
    }
    if (Number(row.terminals) > 0 && Number(row.reserves) === 0) {
      out.push(`order ${row.order_id} has a terminal outcome without a reservation`);
    }
  }
  return out;
};

/**
 * Each wallet's `reserved` balance equals the sum of its open reservations: the RESERVE
 * transactions for orders with no TRANSFER or RELEASE yet (CRD-09, D3 Part 2.1).
 *
 * The other invariants do not imply this one. Moving a credit from `available` to `reserved` with
 * no reservation keeps every wallet non-negative, every transaction balanced, the economy's total
 * equal to what was issued, and each order reserved once and settled once, yet it leaves a credit
 * that no errand can ever release or pay out. `test/invariants.test.ts` shows it catching that case.
 */
export const reservedBackingViolations: CreditInvariant = async (queryable) => {
  const result = await queryable.query<
    Row & { user_id: string; reserved: number; open_reservations: string }
  >(
    `SELECT w.user_id, w.reserved, coalesce(r.amount, 0) AS open_reservations
       FROM wallets w
       LEFT JOIN (
         SELECT t.wallet_user_id, sum(t.amount) AS amount
           FROM credit_transactions t
          WHERE t.transaction_type = 'RESERVE'
            AND NOT EXISTS (
                  SELECT 1 FROM credit_transactions settled
                   WHERE settled.order_id = t.order_id
                     AND settled.transaction_type IN ('TRANSFER', 'RELEASE'))
          GROUP BY t.wallet_user_id
       ) r ON r.wallet_user_id = w.user_id
      WHERE w.reserved <> coalesce(r.amount, 0)
      ORDER BY w.user_id`,
  );
  return result.rows.map(
    (row) =>
      `wallet ${row.user_id} holds ${Number(row.reserved)} reserved but its open reservations ` +
      `total ${Number(row.open_reservations)}`,
  );
};

/** Every invariant, by the name `check-invariants` prints. */
export const CREDIT_INVARIANTS = {
  'no wallet is negative or fractional': balanceViolations,
  "every transaction's debits equal its credits": unbalancedTransactionViolations,
  'all wallets together hold exactly what was issued': conservationViolations,
  'each order is reserved once and settles once': orderOutcomeViolations,
  "every wallet's reserved credits are its open reservations": reservedBackingViolations,
} as const satisfies Record<string, CreditInvariant>;

/** Runs every invariant and returns all violations together. */
export async function creditEconomyViolations(queryable: Queryable): Promise<string[]> {
  const out: string[] = [];
  for (const check of Object.values(CREDIT_INVARIANTS)) out.push(...(await check(queryable)));
  return out;
}
