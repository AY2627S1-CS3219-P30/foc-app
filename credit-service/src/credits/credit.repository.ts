import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  EVENTS,
  creditsReleasedPayload,
  creditsTransferredPayload,
  insertOutboxEvent,
  type Db,
  type Queryable,
  type Row,
} from '@foc/platform';
import { RAW_DB } from '../db/db.js';
import {
  INITIAL_CREDIT_ALLOCATION,
  type LedgerItem,
  type ReleaseInput,
  type ReleaseOutcome,
  type ReleaseResult,
  type ReservationBoundary,
  type ReservationInput,
  type ReservationOutcome,
  type ResultingBalance,
  type TerminalBoundary,
  type TerminalRejection,
  type TransactionType,
  type TransferInput,
  type TransferOutcome,
  type TransferResult,
  type WalletView,
} from './types.js';

type WalletRow = Row & {
  user_id: string;
  available: number;
  reserved: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type OperationRow = Row & {
  operation_type: 'RESERVE' | 'RELEASE' | 'TRANSFER';
  requester_id: string;
  courier_id: string | null;
  amount: number;
  outcome: 'PENDING' | 'SUCCEEDED' | 'REJECTED';
  rejection_reason: 'INSUFFICIENT_CREDITS' | 'AMOUNT_OUT_OF_RANGE' | null;
  available_at_decision: number | null;
  transaction_id: string | null;
  result_payload: unknown | null;
};

type LedgerRow = Row & {
  transaction_id: string;
  transaction_type: TransactionType;
  amount: number;
  order_id: string | null;
  occurred_at: Date | string;
  resulting_available: number;
  resulting_reserved: number;
};

export class WalletNotReadyError extends Error {
  constructor(readonly userId: string) {
    super(`Wallet for ${userId} does not exist yet.`);
    this.name = 'WalletNotReadyError';
  }
}

export class ReservationNotReadyError extends Error {
  constructor(readonly orderId: string) {
    super(`Reservation for ${orderId} is not ready yet.`);
    this.name = 'ReservationNotReadyError';
  }
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const walletView = (row: WalletRow): WalletView => ({
  userId: row.user_id,
  available: Number(row.available),
  reserved: Number(row.reserved),
  total: Number(row.available) + Number(row.reserved),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const balance = (row: { available: number; reserved: number }): ResultingBalance => ({
  available: Number(row.available),
  reserved: Number(row.reserved),
  total: Number(row.available) + Number(row.reserved),
});

/** Credit's single persistence boundary. Event handlers pass their inbox transaction in. */
@Injectable()
export class CreditRepository {
  constructor(@Inject(RAW_DB) private readonly db: Db) {}

  /** Returns true only for the activation that created and funded the wallet. */
  async issueInitial(tx: Queryable, userId: string): Promise<boolean> {
    const inserted = await tx.query<WalletRow>(
      `INSERT INTO wallets (user_id, available, reserved)
       VALUES ($1, $2, 0)
       ON CONFLICT DO NOTHING
       RETURNING user_id, available, reserved, created_at, updated_at`,
      [userId, INITIAL_CREDIT_ALLOCATION],
    );
    if (inserted.rows.length === 0) return false;

    const transactionId = randomUUID();
    await tx.query(
      `INSERT INTO credit_transactions
         (transaction_id, transaction_type, wallet_user_id, amount)
       VALUES ($1, 'ISSUE', $2, $3)`,
      [transactionId, userId, INITIAL_CREDIT_ALLOCATION],
    );
    await tx.query(
      `INSERT INTO ledger_entries
         (entry_id, transaction_id, entry_no, wallet_user_id, account, direction, amount,
          resulting_available, resulting_reserved)
       VALUES
         ($1, $2, 1, NULL, 'PLATFORM_ISSUANCE', 'DEBIT', $3, NULL, NULL),
         ($4, $2, 2, $5, 'AVAILABLE', 'CREDIT', $3, $3, 0)`,
      [randomUUID(), transactionId, INITIAL_CREDIT_ALLOCATION, randomUUID(), userId],
    );
    return true;
  }

  /**
   * Claims an order id, records one outcome and writes the reply outbox row in
   * the caller's inbox transaction. `fault` exists for rollback boundary tests.
   */
  async reserve(
    tx: Queryable,
    input: ReservationInput,
    fault?: (boundary: ReservationBoundary) => void | Promise<void>,
  ): Promise<ReservationOutcome> {
    const claimed = await tx.query(
      `INSERT INTO credit_operations
         (order_id, operation_type, requester_id, amount, outcome)
       VALUES ($1, 'RESERVE', $2, $3, 'PENDING')
       ON CONFLICT DO NOTHING
       RETURNING order_id`,
      [input.orderId, input.requesterId, input.amount],
    );

    if (claimed.rows.length === 0) return this.replayOrRejectConflict(tx, input);
    await fault?.('operation-claimed');

    if (input.amount > 5) {
      const outcome: ReservationOutcome = {
        status: 'REJECTED',
        reason: 'AMOUNT_OUT_OF_RANGE',
      };
      await this.finishRejection(tx, input, outcome);
      await fault?.('operation-finalized');
      await this.writeOutcome(tx, input, outcome);
      await fault?.('outbox-written');
      return outcome;
    }

    const changed = await tx.query<{ available: number; reserved: number } & Row>(
      `UPDATE wallets
          SET available = available - $2,
              reserved = reserved + $2,
              updated_at = now()
        WHERE user_id = $1 AND available >= $2
        RETURNING available, reserved`,
      [input.requesterId, input.amount],
    );

    if (changed.rows.length === 0) {
      const wallet = await tx.query<{ available: number } & Row>(
        `SELECT available FROM wallets WHERE user_id = $1`,
        [input.requesterId],
      );
      if (wallet.rows.length === 0) throw new WalletNotReadyError(input.requesterId);

      const outcome: ReservationOutcome = {
        status: 'REJECTED',
        reason: 'INSUFFICIENT_CREDITS',
        available: Number(wallet.rows[0]!.available),
      };
      await this.finishRejection(tx, input, outcome);
      await fault?.('operation-finalized');
      await this.writeOutcome(tx, input, outcome);
      await fault?.('outbox-written');
      return outcome;
    }
    await fault?.('wallet-updated');

    const balances = changed.rows[0]!;
    const transactionId = randomUUID();
    await tx.query(
      `INSERT INTO credit_transactions
         (transaction_id, order_id, transaction_type, wallet_user_id, amount)
       VALUES ($1, $2, 'RESERVE', $3, $4)`,
      [transactionId, input.orderId, input.requesterId, input.amount],
    );
    await fault?.('transaction-written');
    await tx.query(
      `INSERT INTO ledger_entries
         (entry_id, transaction_id, entry_no, wallet_user_id, account, direction, amount,
          resulting_available, resulting_reserved)
       VALUES
         ($1, $2, 1, $3, 'AVAILABLE', 'DEBIT', $4, $5, $6),
         ($7, $2, 2, $3, 'RESERVED', 'CREDIT', $4, $5, $6)`,
      [
        randomUUID(),
        transactionId,
        input.requesterId,
        input.amount,
        balances.available,
        balances.reserved,
        randomUUID(),
      ],
    );
    await fault?.('ledger-written');
    await tx.query(
      `UPDATE credit_operations
          SET outcome = 'SUCCEEDED', transaction_id = $3
        WHERE order_id = $1 AND operation_type = 'RESERVE' AND requester_id = $2`,
      [input.orderId, input.requesterId, transactionId],
    );
    await fault?.('operation-finalized');

    const outcome: ReservationOutcome = { status: 'RESERVED', transactionId };
    await this.writeOutcome(tx, input, outcome);
    await fault?.('outbox-written');
    return outcome;
  }

  /**
   * Consumes one live reservation and pays its courier. Locking the reservation
   * operation serializes transfer against release for the same order.
   */
  async transfer(
    tx: Queryable,
    input: TransferInput,
    fault?: (boundary: TerminalBoundary) => void | Promise<void>,
  ): Promise<TransferOutcome> {
    const reservation = await this.lockReservation(tx, input.orderId);
    await fault?.('reservation-locked');
    const invalid = await this.validateReservation(tx, reservation, input, 'TRANSFER');
    if (invalid) return invalid;
    if (input.requesterId === input.courierId) {
      return this.rejectTerminal(tx, input, 'TRANSFER', 'INVALID_PARTICIPANTS', {
        reason: 'requester and courier must differ',
      });
    }

    const prior = await this.findTerminalOperation(tx, input.orderId);
    if (prior) return this.replayTransferOrReject(tx, prior, input);

    const participants = await tx.query<{ user_id: string } & Row>(
      `SELECT user_id
         FROM wallets
        WHERE user_id IN ($1, $2)
        ORDER BY user_id
        FOR UPDATE`,
      [input.requesterId, input.courierId],
    );
    if (!participants.rows.some((row) => row.user_id === input.courierId)) {
      throw new WalletNotReadyError(input.courierId);
    }
    if (!participants.rows.some((row) => row.user_id === input.requesterId)) {
      throw new WalletNotReadyError(input.requesterId);
    }

    await tx.query(
      `INSERT INTO credit_operations
         (order_id, operation_type, requester_id, courier_id, amount, outcome)
       VALUES ($1, 'TRANSFER', $2, $3, $4, 'PENDING')`,
      [input.orderId, input.requesterId, input.courierId, input.amount],
    );
    await fault?.('operation-claimed');

    const requester = await tx.query<{ available: number; reserved: number } & Row>(
      `UPDATE wallets
          SET reserved = reserved - $2, updated_at = now()
        WHERE user_id = $1 AND reserved >= $2
        RETURNING available, reserved`,
      [input.requesterId, input.amount],
    );
    if (!requester.rows[0]) {
      throw new Error(
        `Recorded reservation for ${input.orderId} is not backed by reserved credit.`,
      );
    }
    await fault?.('requester-wallet-updated');
    const courier = await tx.query<{ available: number; reserved: number } & Row>(
      `UPDATE wallets
          SET available = available + $2, updated_at = now()
        WHERE user_id = $1
        RETURNING available, reserved`,
      [input.courierId, input.amount],
    );
    if (!courier.rows[0]) throw new WalletNotReadyError(input.courierId);
    await fault?.('courier-wallet-updated');

    const transactionId = randomUUID();
    await tx.query(
      `INSERT INTO credit_transactions
         (transaction_id, order_id, transaction_type, wallet_user_id, amount)
       VALUES ($1, $2, 'TRANSFER', $3, $4)`,
      [transactionId, input.orderId, input.requesterId, input.amount],
    );
    await fault?.('transaction-written');

    const requesterBalance = balance(requester.rows[0]);
    const courierBalance = balance(courier.rows[0]);
    await tx.query(
      `INSERT INTO ledger_entries
         (entry_id, transaction_id, entry_no, wallet_user_id, account, direction, amount,
          resulting_available, resulting_reserved)
       VALUES
         ($1, $2, 1, $3, 'RESERVED', 'DEBIT', $4, $5, $6),
         ($7, $2, 2, $8, 'AVAILABLE', 'CREDIT', $4, $9, $10)`,
      [
        randomUUID(),
        transactionId,
        input.requesterId,
        input.amount,
        requesterBalance.available,
        requesterBalance.reserved,
        randomUUID(),
        input.courierId,
        courierBalance.available,
        courierBalance.reserved,
      ],
    );
    await fault?.('ledger-written');

    const result: TransferResult = {
      orderId: input.orderId,
      requesterId: input.requesterId,
      courierId: input.courierId,
      amount: input.amount,
      transactionId,
      requesterBalance,
      courierBalance,
    };
    await this.finishTerminal(tx, input.orderId, 'TRANSFER', transactionId, result);
    await fault?.('operation-finalized');
    await this.writeTransferOutcome(tx, input, result);
    await fault?.('outbox-written');
    return { status: 'TRANSFERRED', result };
  }

  /** Returns one live reservation to its requester exactly once. */
  async release(
    tx: Queryable,
    input: ReleaseInput,
    fault?: (boundary: TerminalBoundary) => void | Promise<void>,
  ): Promise<ReleaseOutcome> {
    const reservation = await this.lockReservation(tx, input.orderId);
    await fault?.('reservation-locked');
    const invalid = await this.validateReservation(tx, reservation, input, 'RELEASE');
    if (invalid) return invalid;

    const prior = await this.findTerminalOperation(tx, input.orderId);
    if (prior) return this.replayReleaseOrReject(tx, prior, input);

    await tx.query(
      `INSERT INTO credit_operations
         (order_id, operation_type, requester_id, amount, outcome)
       VALUES ($1, 'RELEASE', $2, $3, 'PENDING')`,
      [input.orderId, input.requesterId, input.amount],
    );
    await fault?.('operation-claimed');

    const requester = await tx.query<{ available: number; reserved: number } & Row>(
      `UPDATE wallets
          SET available = available + $2,
              reserved = reserved - $2,
              updated_at = now()
        WHERE user_id = $1 AND reserved >= $2
        RETURNING available, reserved`,
      [input.requesterId, input.amount],
    );
    if (!requester.rows[0]) {
      throw new Error(
        `Recorded reservation for ${input.orderId} is not backed by reserved credit.`,
      );
    }
    await fault?.('requester-wallet-updated');

    const transactionId = randomUUID();
    await tx.query(
      `INSERT INTO credit_transactions
         (transaction_id, order_id, transaction_type, wallet_user_id, amount)
       VALUES ($1, $2, 'RELEASE', $3, $4)`,
      [transactionId, input.orderId, input.requesterId, input.amount],
    );
    await fault?.('transaction-written');

    const requesterBalance = balance(requester.rows[0]);
    await tx.query(
      `INSERT INTO ledger_entries
         (entry_id, transaction_id, entry_no, wallet_user_id, account, direction, amount,
          resulting_available, resulting_reserved)
       VALUES
         ($1, $2, 1, $3, 'RESERVED', 'DEBIT', $4, $5, $6),
         ($7, $2, 2, $3, 'AVAILABLE', 'CREDIT', $4, $5, $6)`,
      [
        randomUUID(),
        transactionId,
        input.requesterId,
        input.amount,
        requesterBalance.available,
        requesterBalance.reserved,
        randomUUID(),
      ],
    );
    await fault?.('ledger-written');

    const result: ReleaseResult = {
      orderId: input.orderId,
      requesterId: input.requesterId,
      amount: input.amount,
      transactionId,
      requesterBalance,
    };
    await this.finishTerminal(tx, input.orderId, 'RELEASE', transactionId, result);
    await fault?.('operation-finalized');
    await this.writeReleaseOutcome(tx, input, result);
    await fault?.('outbox-written');
    return { status: 'RELEASED', result };
  }

  async findWallet(userId: string, queryable: Queryable = this.db): Promise<WalletView | null> {
    const result = await queryable.query<WalletRow>(
      `SELECT user_id, available, reserved, created_at, updated_at
         FROM wallets WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ? walletView(result.rows[0]) : null;
  }

  async listLedger(
    userId: string,
    limit: number,
    cursor?: { occurredAt: string; transactionId: string },
    queryable: Queryable = this.db,
  ): Promise<{ rows: LedgerItem[]; hasMore: boolean }> {
    const params: unknown[] = [userId];
    const cursorSql = cursor
      ? (() => {
          params.push(cursor.occurredAt, cursor.transactionId);
          return `WHERE (occurred_at, transaction_id) < ($2::timestamptz, $3::uuid)`;
        })()
      : '';
    params.push(limit + 1);
    const limitParameter = `$${params.length}`;

    const result = await queryable.query<LedgerRow>(
      `WITH activity AS (
         SELECT DISTINCT ON (t.transaction_id)
                t.transaction_id, t.transaction_type, t.amount, t.order_id, t.occurred_at,
                e.resulting_available, e.resulting_reserved
           FROM credit_transactions t
           JOIN ledger_entries e ON e.transaction_id = t.transaction_id
          WHERE e.wallet_user_id = $1
          ORDER BY t.transaction_id, e.entry_no DESC
       )
       SELECT transaction_id, transaction_type, amount, order_id, occurred_at,
              resulting_available, resulting_reserved
         FROM activity
         ${cursorSql}
        ORDER BY occurred_at DESC, transaction_id DESC
        LIMIT ${limitParameter}`,
      params,
    );
    const hasMore = result.rows.length > limit;
    return {
      hasMore,
      rows: result.rows.slice(0, limit).map((row) => ({
        transactionId: row.transaction_id,
        type: row.transaction_type,
        amount: Number(row.amount),
        orderId: row.order_id,
        occurredAt: iso(row.occurred_at),
        resultingAvailable: Number(row.resulting_available),
        resultingReserved: Number(row.resulting_reserved),
        resultingTotal: Number(row.resulting_available) + Number(row.resulting_reserved),
      })),
    };
  }

  async auditAdminRead(
    adminUserId: string,
    targetUserId: string,
    resource: 'WALLET' | 'LEDGER',
    correlationId: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO admin_wallet_reads
         (audit_id, admin_user_id, target_user_id, resource, correlation_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), adminUserId, targetUserId, resource, correlationId],
    );
  }

  private async lockReservation(tx: Queryable, orderId: string): Promise<OperationRow> {
    const result = await tx.query<OperationRow>(
      `SELECT operation_type, requester_id, courier_id, amount, outcome, rejection_reason,
              available_at_decision, transaction_id, result_payload
         FROM credit_operations
        WHERE order_id = $1 AND operation_type = 'RESERVE'
        FOR UPDATE`,
      [orderId],
    );
    const reservation = result.rows[0];
    if (!reservation || reservation.outcome === 'PENDING') {
      throw new ReservationNotReadyError(orderId);
    }
    return reservation;
  }

  private async validateReservation(
    tx: Queryable,
    reservation: OperationRow,
    input: ReleaseInput | TransferInput,
    operationType: 'RELEASE' | 'TRANSFER',
  ): Promise<{ status: 'REJECTED'; reason: TerminalRejection } | null> {
    if (reservation.outcome !== 'SUCCEEDED' || !reservation.transaction_id) {
      return this.rejectTerminal(tx, input, operationType, 'RESERVATION_NOT_ACTIVE', {
        reservationOutcome: reservation.outcome,
      });
    }
    if (
      reservation.requester_id !== input.requesterId ||
      Number(reservation.amount) !== input.amount
    ) {
      return this.rejectTerminal(tx, input, operationType, 'CONFLICTING_REQUEST', {
        recorded: {
          requesterId: reservation.requester_id,
          amount: Number(reservation.amount),
        },
        received: { requesterId: input.requesterId, amount: input.amount },
      });
    }
    return null;
  }

  private async findTerminalOperation(
    tx: Queryable,
    orderId: string,
  ): Promise<OperationRow | null> {
    const result = await tx.query<OperationRow>(
      `SELECT operation_type, requester_id, courier_id, amount, outcome, rejection_reason,
              available_at_decision, transaction_id, result_payload
         FROM credit_operations
        WHERE order_id = $1 AND operation_type IN ('RELEASE', 'TRANSFER')
        FOR UPDATE`,
      [orderId],
    );
    return result.rows[0] ?? null;
  }

  private async replayTransferOrReject(
    tx: Queryable,
    prior: OperationRow,
    input: TransferInput,
  ): Promise<TransferOutcome> {
    if (
      prior.operation_type !== 'TRANSFER' ||
      prior.requester_id !== input.requesterId ||
      prior.courier_id !== input.courierId ||
      Number(prior.amount) !== input.amount
    ) {
      const reason: TerminalRejection =
        prior.operation_type === 'TRANSFER' ? 'CONFLICTING_REQUEST' : 'TERMINAL_OPERATION_CONFLICT';
      return this.rejectTerminal(tx, input, 'TRANSFER', reason, {
        recorded: {
          operationType: prior.operation_type,
          requesterId: prior.requester_id,
          courierId: prior.courier_id,
          amount: Number(prior.amount),
        },
      });
    }
    if (prior.outcome !== 'SUCCEEDED' || !prior.result_payload) {
      throw new Error(`Transfer outcome for ${input.orderId} is not replayable.`);
    }
    const result = creditsTransferredPayload.parse(prior.result_payload);
    await this.writeTransferOutcome(tx, input, result);
    return { status: 'TRANSFERRED', result };
  }

  private async replayReleaseOrReject(
    tx: Queryable,
    prior: OperationRow,
    input: ReleaseInput,
  ): Promise<ReleaseOutcome> {
    if (
      prior.operation_type !== 'RELEASE' ||
      prior.requester_id !== input.requesterId ||
      Number(prior.amount) !== input.amount
    ) {
      const reason: TerminalRejection =
        prior.operation_type === 'RELEASE' ? 'CONFLICTING_REQUEST' : 'TERMINAL_OPERATION_CONFLICT';
      return this.rejectTerminal(tx, input, 'RELEASE', reason, {
        recorded: {
          operationType: prior.operation_type,
          requesterId: prior.requester_id,
          courierId: prior.courier_id,
          amount: Number(prior.amount),
        },
      });
    }
    if (prior.outcome !== 'SUCCEEDED' || !prior.result_payload) {
      throw new Error(`Release outcome for ${input.orderId} is not replayable.`);
    }
    const result = creditsReleasedPayload.parse(prior.result_payload);
    await this.writeReleaseOutcome(tx, input, result);
    return { status: 'RELEASED', result };
  }

  private async rejectTerminal(
    tx: Queryable,
    input: ReleaseInput | TransferInput,
    operationType: 'RELEASE' | 'TRANSFER',
    reason: TerminalRejection,
    details: Record<string, unknown>,
  ): Promise<{ status: 'REJECTED'; reason: TerminalRejection }> {
    await tx.query(
      `INSERT INTO credit_audit_alerts
         (alert_id, order_id, operation_type, code, details, correlation_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        randomUUID(),
        input.orderId,
        operationType,
        reason,
        JSON.stringify({
          ...details,
          received: { ...input, correlationId: undefined, causationId: undefined },
        }),
        input.correlationId,
      ],
    );
    return { status: 'REJECTED', reason };
  }

  private async finishTerminal(
    tx: Queryable,
    orderId: string,
    operationType: 'RELEASE' | 'TRANSFER',
    transactionId: string,
    result: ReleaseResult | TransferResult,
  ): Promise<void> {
    await tx.query(
      `UPDATE credit_operations
          SET outcome = 'SUCCEEDED', transaction_id = $3, result_payload = $4::jsonb
        WHERE order_id = $1 AND operation_type = $2`,
      [orderId, operationType, transactionId, JSON.stringify(result)],
    );
  }

  private async writeTransferOutcome(
    tx: Queryable,
    input: TransferInput,
    result: TransferResult,
  ): Promise<void> {
    await insertOutboxEvent(tx, {
      eventType: EVENTS.CREDITS_TRANSFERRED,
      aggregateId: input.orderId,
      payload: result,
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
  }

  private async writeReleaseOutcome(
    tx: Queryable,
    input: ReleaseInput,
    result: ReleaseResult,
  ): Promise<void> {
    await insertOutboxEvent(tx, {
      eventType: EVENTS.CREDITS_RELEASED,
      aggregateId: input.orderId,
      payload: result,
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
  }

  private async replayOrRejectConflict(
    tx: Queryable,
    input: ReservationInput,
  ): Promise<ReservationOutcome> {
    const existing = await tx.query<OperationRow>(
      `SELECT requester_id, amount, outcome, rejection_reason,
              available_at_decision, transaction_id
         FROM credit_operations
        WHERE order_id = $1 AND operation_type = 'RESERVE'`,
      [input.orderId],
    );
    const operation = existing.rows[0];
    if (!operation) throw new Error('Reservation operation conflict disappeared.');

    if (operation.requester_id !== input.requesterId || Number(operation.amount) !== input.amount) {
      await tx.query(
        `INSERT INTO credit_audit_alerts
           (alert_id, order_id, operation_type, code, details, correlation_id)
         VALUES ($1, $2, 'RESERVE', 'CONFLICTING_REQUEST', $3::jsonb, $4)`,
        [
          randomUUID(),
          input.orderId,
          JSON.stringify({
            recorded: {
              requesterId: operation.requester_id,
              amount: Number(operation.amount),
            },
            received: { requesterId: input.requesterId, amount: input.amount },
          }),
          input.correlationId,
        ],
      );
      const conflict: ReservationOutcome = {
        status: 'REJECTED',
        reason: 'CONFLICTING_REQUEST',
      };
      await this.writeOutcome(tx, input, conflict);
      return conflict;
    }

    if (operation.outcome === 'PENDING') throw new Error('Reservation outcome is still pending.');
    const outcome: ReservationOutcome =
      operation.outcome === 'SUCCEEDED'
        ? { status: 'RESERVED', transactionId: operation.transaction_id! }
        : {
            status: 'REJECTED',
            reason: operation.rejection_reason!,
            ...(operation.available_at_decision === null
              ? {}
              : { available: Number(operation.available_at_decision) }),
          };
    await this.writeOutcome(tx, input, outcome);
    return outcome;
  }

  private async finishRejection(
    tx: Queryable,
    input: ReservationInput,
    outcome: Extract<ReservationOutcome, { status: 'REJECTED' }>,
  ): Promise<void> {
    await tx.query(
      `UPDATE credit_operations
          SET outcome = 'REJECTED', rejection_reason = $3, available_at_decision = $4
        WHERE order_id = $1 AND operation_type = 'RESERVE' AND requester_id = $2`,
      [input.orderId, input.requesterId, outcome.reason, outcome.available ?? null],
    );
  }

  private async writeOutcome(
    tx: Queryable,
    input: ReservationInput,
    outcome: ReservationOutcome,
  ): Promise<void> {
    const base = {
      orderId: input.orderId,
      requesterId: input.requesterId,
      amount: input.amount,
    };
    if (outcome.status === 'RESERVED') {
      await insertOutboxEvent(tx, {
        eventType: EVENTS.CREDITS_RESERVED,
        aggregateId: input.orderId,
        payload: base,
        correlationId: input.correlationId,
        causationId: input.causationId,
      });
      return;
    }
    await insertOutboxEvent(tx, {
      eventType: EVENTS.CREDIT_RESERVATION_REJECTED,
      aggregateId: input.orderId,
      payload:
        outcome.reason === 'INSUFFICIENT_CREDITS'
          ? { ...base, reason: outcome.reason, available: outcome.available! }
          : { ...base, reason: outcome.reason },
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
  }
}
