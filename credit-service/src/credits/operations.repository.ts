import { Inject, Injectable } from '@nestjs/common';
import type { Db, Row } from '@foc/platform';
import { RAW_DB } from '../db/db.js';

const iso = (value: Date | string): string => new Date(value).toISOString();

type AlertRow = Row & {
  alert_id: string;
  order_id: string;
  operation_type: string;
  code: string;
  details: unknown;
  correlation_id: string;
  occurred_at: Date | string;
};

const toAlert = (a: AlertRow) => ({
  alertId: a.alert_id,
  orderId: a.order_id,
  operationType: a.operation_type,
  code: a.code,
  details: a.details,
  correlationId: a.correlation_id,
  occurredAt: iso(a.occurred_at),
});

/**
 * PLT-05 — the Credit Service's half of an errand's trace, and its audit alerts. Read-only, and
 * without balances: an operation's `available_at_decision` and the ledger's running balances stay
 * behind the recorded wallet reads (ADM-03).
 */
@Injectable()
export class CreditOperationsRepository {
  constructor(@Inject(RAW_DB) private readonly db: Db) {}

  /** What Credit decided for one errand: its operations, the transactions they made, and alerts. */
  async orderCredit(orderId: string) {
    const [operations, transactions, alerts] = await Promise.all([
      this.db.query<
        Row & {
          operation_type: string;
          requester_id: string;
          courier_id: string | null;
          amount: number;
          outcome: string;
          rejection_reason: string | null;
          transaction_id: string | null;
          created_at: Date | string;
        }
      >(
        `SELECT operation_type, requester_id, courier_id, amount, outcome, rejection_reason,
                transaction_id, created_at
           FROM credit_operations WHERE order_id = $1 ORDER BY created_at, operation_type`,
        [orderId],
      ),
      this.db.query<
        Row & {
          transaction_id: string;
          transaction_type: string;
          wallet_user_id: string | null;
          amount: number;
          occurred_at: Date | string;
        }
      >(
        `SELECT transaction_id, transaction_type, wallet_user_id, amount, occurred_at
           FROM credit_transactions WHERE order_id = $1 ORDER BY occurred_at, transaction_type`,
        [orderId],
      ),
      this.db.query<AlertRow>(
        `SELECT alert_id, order_id, operation_type, code, details, correlation_id, occurred_at
           FROM credit_audit_alerts WHERE order_id = $1 ORDER BY occurred_at, alert_id`,
        [orderId],
      ),
    ]);
    return {
      orderId,
      operations: operations.rows.map((o) => ({
        operationType: o.operation_type,
        requesterId: o.requester_id,
        courierId: o.courier_id,
        amount: Number(o.amount),
        outcome: o.outcome,
        rejectionReason: o.rejection_reason,
        transactionId: o.transaction_id,
        createdAt: iso(o.created_at),
      })),
      transactions: transactions.rows.map((t) => ({
        transactionId: t.transaction_id,
        transactionType: t.transaction_type,
        walletUserId: t.wallet_user_id,
        amount: Number(t.amount),
        occurredAt: iso(t.occurred_at),
      })),
      alerts: alerts.rows.map(toAlert),
    };
  }

  /** Audit alerts across every errand, newest first: requests Credit refused as inconsistent. */
  async alerts(limit = 100) {
    const result = await this.db.query<AlertRow>(
      `SELECT alert_id, order_id, operation_type, code, details, correlation_id, occurred_at
         FROM credit_audit_alerts ORDER BY occurred_at DESC, alert_id LIMIT $1`,
      [limit],
    );
    return { items: result.rows.map(toAlert) };
  }
}
