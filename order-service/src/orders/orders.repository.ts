import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  EVENTS,
  UnparseableMessageError,
  insertOutboxEvent,
  type Queryable,
  type Row,
} from '@foc/platform';
import { ORDER_DB, type OrderDatabase } from '../db/db.js';
import {
  ORDER_TRANSITIONS,
  decideTransition,
  type OrderAction,
  type OrderActor,
  type TransitionDecision,
} from './order-state-machine.js';
import type {
  OpenOrderSummary,
  OrderReceipt,
  OrderRow,
  OrderStatus,
  SupplierSnapshot,
  OrderItem,
} from './types.js';
import type { CreateOrderInput } from './validation.js';

type StoredOrder = Row & {
  order_id: string;
  requester_id: string;
  courier_id: string | null;
  referred_admin_id: string | null;
  supplier_snapshot: SupplierSnapshot;
  items: OrderItem[];
  delivery_zone: string;
  delivery_instructions: string;
  reward: number;
  status: OrderStatus;
  release_reason: 'CANCELLED' | 'EXPIRED' | null;
  rejection_reason: string | null;
  available_at_rejection: number | null;
  version: number;
  acceptance_deadline_at: Date | string | null;
  accepted_at: Date | string | null;
  picked_up_at: Date | string | null;
  delivered_at: Date | string | null;
  completion_requested_at: Date | string | null;
  completed_at: Date | string | null;
  release_requested_at: Date | string | null;
  released_at: Date | string | null;
  credit_transaction_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export const ORDER_COLUMNS = `order_id, requester_id, courier_id, referred_admin_id, supplier_snapshot,
  items, delivery_zone, delivery_instructions, reward, status, release_reason, rejection_reason,
  available_at_rejection, version, acceptance_deadline_at, accepted_at, picked_up_at, delivered_at,
  completion_requested_at, completed_at, release_requested_at, released_at, credit_transaction_id,
  created_at, updated_at`;

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const nullableIso = (value: Date | string | null): string | null => (value ? iso(value) : null);

const mapOrder = (row: StoredOrder): OrderRow => ({
  orderId: row.order_id,
  requesterId: row.requester_id,
  courierId: row.courier_id,
  referredAdminId: row.referred_admin_id,
  supplierSnapshot: row.supplier_snapshot,
  items: row.items,
  deliveryZone: row.delivery_zone,
  deliveryInstructions: row.delivery_instructions,
  reward: Number(row.reward),
  status: row.status,
  releaseReason: row.release_reason,
  rejectionReason: row.rejection_reason,
  availableAtRejection:
    row.available_at_rejection === null ? null : Number(row.available_at_rejection),
  version: Number(row.version),
  acceptanceDeadlineAt: nullableIso(row.acceptance_deadline_at),
  acceptedAt: nullableIso(row.accepted_at),
  pickedUpAt: nullableIso(row.picked_up_at),
  deliveredAt: nullableIso(row.delivered_at),
  completionRequestedAt: nullableIso(row.completion_requested_at),
  completedAt: nullableIso(row.completed_at),
  releaseRequestedAt: nullableIso(row.release_requested_at),
  releasedAt: nullableIso(row.released_at),
  creditTransactionId: row.credit_transaction_id,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export type CreationBoundary =
  | 'order-written'
  | 'history-written'
  | 'idempotency-written'
  | 'status-outbox-written'
  | 'reservation-outbox-written';

export interface CreatePendingInput extends CreateOrderInput {
  requesterId: string;
  supplierSnapshot: SupplierSnapshot;
  idempotencyKey: string;
  requestHash: string;
  correlationId: string;
}

export interface ReservationResultInput {
  orderId: string;
  requesterId: string;
  amount: number;
  correlationId: string;
  causationId: string;
  acceptanceWindowMs: number;
  outcome:
    | { kind: 'RESERVED' }
    | {
        kind: 'REJECTED';
        reason: 'INSUFFICIENT_CREDITS' | 'AMOUNT_OUT_OF_RANGE' | 'CONFLICTING_REQUEST';
        available?: number;
      };
}

export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('Idempotency-Key was reused with a different order request.');
    this.name = 'IdempotencyKeyReusedError';
  }
}

@Injectable()
export class OrdersRepository {
  constructor(@Inject(ORDER_DB) private readonly db: OrderDatabase) {}

  async findById(orderId: string): Promise<OrderRow | undefined> {
    return this.findByIdUsing(this.db, orderId);
  }

  private async findByIdUsing(db: Queryable, orderId: string): Promise<OrderRow | undefined> {
    const result = await db.query<StoredOrder>(
      `SELECT ${ORDER_COLUMNS}
         FROM orders
        WHERE order_id = $1`,
      [orderId],
    );
    return result.rows[0] ? mapOrder(result.rows[0]) : undefined;
  }

  async listOpen(now = new Date()): Promise<OpenOrderSummary[]> {
    const result = await this.db.query<StoredOrder>(
      `SELECT ${ORDER_COLUMNS}
         FROM orders
        WHERE status = 'OPEN' AND acceptance_deadline_at > $1
        ORDER BY acceptance_deadline_at, created_at, order_id
        LIMIT 100`,
      [now.toISOString()],
    );
    return result.rows.map((stored) => {
      const order = mapOrder(stored);
      return {
        orderId: order.orderId,
        supplier: order.supplierSnapshot,
        itemSummary: order.items.map(({ name, quantity }) => ({ name, quantity })),
        deliveryZone: order.deliveryZone,
        reward: order.reward,
        status: 'OPEN',
        version: order.version,
        acceptanceDeadlineAt: order.acceptanceDeadlineAt!,
        timeRemainingSeconds: Math.max(
          0,
          Math.ceil((new Date(order.acceptanceDeadlineAt!).getTime() - now.getTime()) / 1000),
        ),
        createdAt: order.createdAt,
      };
    });
  }

  /** Errands the user requested or is the current courier of, most recently changed first. */
  async listMine(userId: string): Promise<OrderRow[]> {
    const result = await this.db.query<StoredOrder>(
      `SELECT ${ORDER_COLUMNS}
         FROM orders
        WHERE requester_id = $1 OR courier_id = $1
        ORDER BY updated_at DESC, order_id
        LIMIT 100`,
      [userId],
    );
    return result.rows.map(mapOrder);
  }

  async findIdempotent(
    requesterId: string,
    idempotencyKey: string,
  ): Promise<{ requestHash: string; order: OrderRow } | undefined> {
    const result = await this.db.query<{ request_hash: string; order_id: string } & Row>(
      `SELECT request_hash, order_id
         FROM order_idempotency_keys
        WHERE requester_id = $1 AND idempotency_key = $2`,
      [requesterId, idempotencyKey],
    );
    if (!result.rows[0]) return undefined;
    const order = await this.findById(result.rows[0].order_id);
    return order ? { requestHash: result.rows[0].request_hash, order } : undefined;
  }

  /** The database clock, so timers and the acceptance check compare against the same time. */
  async databaseNow(): Promise<Date> {
    const result = await this.db.query<{ now: Date | string } & Row>(`SELECT now() AS now`);
    return new Date(result.rows[0]!.now);
  }

  /** OPEN orders whose acceptance deadline has passed (OS-FR6.1.2). */
  async findOverdueOpen(now: Date, limit = 100): Promise<string[]> {
    const result = await this.db.query<{ order_id: string } & Row>(
      `SELECT order_id FROM orders
        WHERE status = 'OPEN' AND acceptance_deadline_at <= $1
        ORDER BY acceptance_deadline_at, order_id
        LIMIT $2`,
      [now.toISOString(), limit],
    );
    return result.rows.map((row) => row.order_id);
  }

  /** ACCEPTED orders with no pickup recorded within the pickup timeout (OS-FR6.1.3). */
  async findPickupOverdue(cutoff: Date, limit = 100): Promise<string[]> {
    const result = await this.db.query<{ order_id: string } & Row>(
      `SELECT order_id FROM orders
        WHERE status = 'ACCEPTED' AND accepted_at <= $1
        ORDER BY accepted_at, order_id
        LIMIT $2`,
      [cutoff.toISOString(), limit],
    );
    return result.rows.map((row) => row.order_id);
  }

  /**
   * Raises the CREDIT_WAIT_EXCEEDED operator alert for every order that has waited in
   * PENDING_CREDIT since before `cutoff` and has none yet (OS-FR1.1.3). Returns only the alerts
   * raised by this call, so each order is surfaced once. The order itself is never changed:
   * the reservation may still arrive.
   */
  async raiseCreditWaitAlerts(
    cutoff: Date,
    limit = 100,
  ): Promise<Array<{ orderId: string; createdAt: string; raisedAt: string }>> {
    const result = await this.db.query<
      { order_id: string; created_at: Date | string; raised_at: Date | string } & Row
    >(
      `INSERT INTO order_operator_alerts (order_id, kind, raised_at, detail)
       SELECT order_id, 'CREDIT_WAIT_EXCEEDED', now(),
              jsonb_build_object('createdAt', created_at, 'requesterId', requester_id)
         FROM orders
        WHERE status = 'PENDING_CREDIT' AND created_at <= $1
          AND NOT EXISTS (
            SELECT 1 FROM order_operator_alerts a
             WHERE a.order_id = orders.order_id AND a.kind = 'CREDIT_WAIT_EXCEEDED')
        ORDER BY created_at, order_id
        LIMIT $2
       ON CONFLICT (order_id, kind) DO NOTHING
       RETURNING order_id, (detail->>'createdAt')::timestamptz AS created_at, raised_at`,
      [cutoff.toISOString(), limit],
    );
    return result.rows.map((row) => ({
      orderId: row.order_id,
      createdAt: iso(row.created_at),
      raisedAt: iso(row.raised_at),
    }));
  }

  /** Orders still waiting for Credit since before `cutoff`, for the operator view. */
  async listCreditWaitExceeded(cutoff: Date, limit = 100) {
    const result = await this.db.query<
      {
        order_id: string;
        requester_id: string;
        reward: number;
        created_at: Date | string;
        raised_at: Date | string | null;
      } & Row
    >(
      `SELECT o.order_id, o.requester_id, o.reward, o.created_at, a.raised_at
         FROM orders o
         LEFT JOIN order_operator_alerts a
           ON a.order_id = o.order_id AND a.kind = 'CREDIT_WAIT_EXCEEDED'
        WHERE o.status = 'PENDING_CREDIT' AND o.created_at <= $1
        ORDER BY o.created_at, o.order_id
        LIMIT $2`,
      [cutoff.toISOString(), limit],
    );
    return result.rows.map((row) => ({
      orderId: row.order_id,
      requesterId: row.requester_id,
      reward: Number(row.reward),
      createdAt: iso(row.created_at),
      alertRaisedAt: row.raised_at ? iso(row.raised_at) : null,
    }));
  }

  async findHistory(orderId: string) {
    const result = await this.db.query<
      {
        previous_status: OrderStatus | null;
        new_status: OrderStatus;
        action: string;
        actor_type: string;
        actor_id: string | null;
        order_version: number;
        occurred_at: Date | string;
      } & Row
    >(
      `SELECT previous_status, new_status, action, actor_type, actor_id, order_version, occurred_at
         FROM order_status_history
        WHERE order_id = $1
        ORDER BY order_version`,
      [orderId],
    );
    return result.rows.map((row) => ({
      previousStatus: row.previous_status,
      newStatus: row.new_status,
      action: row.action,
      actorType: row.actor_type,
      actorId: row.actor_id,
      version: Number(row.order_version),
      occurredAt: iso(row.occurred_at),
    }));
  }

  /**
   * Orders waiting on Credit since before `staleBefore` that no run has attempted since
   * `retryAfter`, and whose original request has already left the outbox (otherwise the relay,
   * not reconciliation, is what they are waiting for).
   */
  async findReconciliationCandidates(staleAfterMs: number, retryAfterMs: number, limit = 100) {
    const result = await this.db.query<
      { order_id: string; status: PendingCreditStatus; version: number } & Row
    >(
      `SELECT o.order_id, o.status, o.version
         FROM orders o
        WHERE ((o.status = 'PENDING_CREDIT' AND o.created_at <= now() - $1 * interval '1 millisecond')
            OR (o.status = 'COMPLETION_PENDING_CREDIT'
                AND o.completion_requested_at <= now() - $1 * interval '1 millisecond')
            OR (o.status = 'RELEASE_PENDING_CREDIT'
                AND o.release_requested_at <= now() - $1 * interval '1 millisecond'))
          AND NOT EXISTS (
            SELECT 1 FROM order_reconciliation_attempts a
             WHERE a.order_id = o.order_id
               AND a.attempted_at > now() - $2 * interval '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM outbox_events e
             WHERE e.aggregate_id = o.order_id::text AND e.published_at IS NULL
               AND e.event_type IN ($4, $5, $6))
        ORDER BY o.updated_at, o.order_id
        LIMIT $3`,
      [
        staleAfterMs,
        retryAfterMs,
        limit,
        EVENTS.CREDIT_RESERVATION_REQUESTED,
        EVENTS.ORDER_COMPLETION_REQUESTED,
        EVENTS.CREDIT_RELEASE_REQUESTED,
      ],
    );
    return result.rows.map((row) => ({
      orderId: row.order_id,
      status: row.status,
      version: Number(row.version),
    }));
  }

  /**
   * Records one reconciliation decision under the order's row lock. Returns null — and changes
   * nothing — if another run holds the order, the order moved on since it was read, or another run
   * already attempted it within the retry window; so overlapping runs repair an order once.
   */
  async recordReconciliation(input: {
    orderId: string;
    observed: { status: PendingCreditStatus; version: number };
    runId: string;
    retryAfterMs: number;
    credit: { status: string; detail: string | null } | null;
    action: 'REISSUE' | 'ALERT' | 'CREDIT_UNAVAILABLE';
    correlationId: string;
  }): Promise<{
    action: 'REISSUED' | 'ALERTED' | 'CREDIT_UNAVAILABLE';
    eventId: string | null;
    alertRaised: boolean;
  } | null> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.query<StoredOrder>(
        `SELECT ${ORDER_COLUMNS} FROM orders WHERE order_id = $1 FOR UPDATE SKIP LOCKED`,
        [input.orderId],
      );
      const stored = locked.rows[0];
      if (!stored) return null;
      const order = mapOrder(stored);
      if (order.status !== input.observed.status || order.version !== input.observed.version) {
        return null;
      }
      const recent = await tx.query(
        `SELECT 1 FROM order_reconciliation_attempts
          WHERE order_id = $1 AND attempted_at > now() - $2 * interval '1 millisecond'`,
        [input.orderId, input.retryAfterMs],
      );
      if (recent.rows.length > 0) return null;

      let eventId: string | null = null;
      let alertRaised = false;
      if (input.action === 'REISSUE') {
        eventId = await insertOutboxEvent(tx, {
          ...creditRequest(order),
          aggregateId: order.orderId,
          correlationId: input.correlationId,
        } as Parameters<typeof insertOutboxEvent>[1]);
      } else if (input.action === 'ALERT') {
        const raised = await tx.query(
          `INSERT INTO order_operator_alerts (order_id, kind, detail)
           VALUES ($1, 'CREDIT_STATE_CONFLICT', $2::jsonb)
           ON CONFLICT (order_id, kind) DO NOTHING
           RETURNING order_id`,
          [
            order.orderId,
            JSON.stringify({
              orderStatus: order.status,
              creditStatus: input.credit?.status ?? null,
            }),
          ],
        );
        alertRaised = raised.rows.length > 0;
      }
      const action =
        input.action === 'REISSUE'
          ? 'REISSUED'
          : input.action === 'ALERT'
            ? 'ALERTED'
            : 'CREDIT_UNAVAILABLE';
      await tx.query(
        `INSERT INTO order_reconciliation_attempts
           (attempt_id, run_id, order_id, order_status, order_version, credit_status, credit_detail,
            action, reissued_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          input.runId,
          order.orderId,
          order.status,
          order.version,
          input.credit?.status ?? null,
          input.credit?.detail ?? null,
          action,
          eventId,
        ],
      );
      return { action, eventId, alertRaised };
    });
  }

  async listReconciliationAttempts(limit = 100) {
    const result = await this.db.query<
      {
        attempt_id: string;
        run_id: string;
        order_id: string;
        order_status: string;
        order_version: number;
        credit_status: string | null;
        credit_detail: string | null;
        action: string;
        reissued_event_id: string | null;
        attempted_at: Date | string;
      } & Row
    >(
      `SELECT * FROM order_reconciliation_attempts ORDER BY attempted_at DESC, attempt_id LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      attemptId: row.attempt_id,
      runId: row.run_id,
      orderId: row.order_id,
      orderStatus: row.order_status,
      orderVersion: Number(row.order_version),
      creditStatus: row.credit_status,
      creditDetail: row.credit_detail,
      action: row.action,
      reissuedEventId: row.reissued_event_id,
      attemptedAt: iso(row.attempted_at),
    }));
  }

  /** Durable discovery boundary for #150; it never changes or rejects the order itself. */
  async findStalePendingCredit(
    cutoff: Date,
    limit = 100,
  ): Promise<Array<{ orderId: string; createdAt: string }>> {
    const result = await this.db.query<{ order_id: string; created_at: Date | string } & Row>(
      `SELECT order_id, created_at
         FROM orders
        WHERE status = 'PENDING_CREDIT' AND created_at <= $1
        ORDER BY created_at, order_id
        LIMIT $2`,
      [cutoff.toISOString(), limit],
    );
    return result.rows.map((row) => ({ orderId: row.order_id, createdAt: iso(row.created_at) }));
  }

  async createPending(
    input: CreatePendingInput,
    fault?: (boundary: CreationBoundary) => void | Promise<void>,
  ): Promise<{ order: OrderRow; replayed: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `${input.requesterId}:${input.idempotencyKey}`,
      ]);
      const existing = await tx.query<{ request_hash: string; order_id: string } & Row>(
        `SELECT request_hash, order_id
           FROM order_idempotency_keys
          WHERE requester_id = $1 AND idempotency_key = $2`,
        [input.requesterId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== input.requestHash) {
          throw new IdempotencyKeyReusedError();
        }
        const order = await this.findByIdUsing(tx, existing.rows[0].order_id);
        if (!order) throw new Error('Idempotency record references a missing order.');
        return { order, replayed: true };
      }

      const orderId = randomUUID();
      const historyId = randomUUID();
      const occurredAt = new Date().toISOString();
      await tx.query(
        `INSERT INTO orders
           (order_id, requester_id, supplier_snapshot, items, delivery_zone,
            delivery_instructions, reward, status, version, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, 'PENDING_CREDIT', 1, $8, $8)`,
        [
          orderId,
          input.requesterId,
          JSON.stringify(input.supplierSnapshot),
          JSON.stringify(input.items),
          input.deliveryZone,
          input.deliveryInstructions,
          input.reward,
          occurredAt,
        ],
      );
      await fault?.('order-written');
      await tx.query(
        `INSERT INTO order_status_history
           (history_id, order_id, previous_status, new_status, action, actor_type, actor_id,
            order_version, occurred_at)
         VALUES ($1, $2, NULL, 'PENDING_CREDIT', 'CREATE', 'REQUESTER', $3, 1, $4)`,
        [historyId, orderId, input.requesterId, occurredAt],
      );
      await fault?.('history-written');
      await tx.query(
        `INSERT INTO order_idempotency_keys
           (requester_id, idempotency_key, order_id, request_hash)
         VALUES ($1, $2, $3, $4)`,
        [input.requesterId, input.idempotencyKey, orderId, input.requestHash],
      );
      await fault?.('idempotency-written');
      await insertOutboxEvent(tx, {
        eventType: EVENTS.ORDER_STATUS_CHANGED,
        aggregateId: orderId,
        correlationId: input.correlationId,
        payload: {
          orderId,
          previousStatus: null,
          newStatus: 'PENDING_CREDIT',
          occurredAt,
        },
      });
      await fault?.('status-outbox-written');
      await insertOutboxEvent(tx, {
        eventType: EVENTS.CREDIT_RESERVATION_REQUESTED,
        aggregateId: orderId,
        correlationId: input.correlationId,
        payload: { orderId, requesterId: input.requesterId, amount: input.reward },
      });
      await fault?.('reservation-outbox-written');

      const order = await this.findByIdUsing(tx, orderId);
      if (!order) throw new Error('Newly inserted order could not be read.');
      return { order, replayed: false };
    });
  }

  async applyReservationResult(tx: Queryable, input: ReservationResultInput): Promise<boolean> {
    const result = await tx.query<StoredOrder>(
      `SELECT ${ORDER_COLUMNS}
         FROM orders
        WHERE order_id = $1
        FOR UPDATE`,
      [input.orderId],
    );
    const stored = result.rows[0];
    if (!stored) throw new UnparseableMessageError('reservation result names an unknown order');
    const order = mapOrder(stored);
    if (order.requesterId !== input.requesterId || order.reward !== input.amount) {
      throw new UnparseableMessageError('reservation result does not match the recorded request');
    }

    const target = input.outcome.kind === 'RESERVED' ? 'OPEN' : 'REJECTED';
    if (order.status === target) {
      if (
        input.outcome.kind === 'REJECTED' &&
        (order.rejectionReason !== input.outcome.reason ||
          order.availableAtRejection !== (input.outcome.available ?? null))
      ) {
        throw new UnparseableMessageError(
          'reservation rejection conflicts with the recorded outcome',
        );
      }
      return false;
    }
    if (order.status !== 'PENDING_CREDIT') {
      throw new UnparseableMessageError(
        `reservation result cannot move order from ${order.status} to ${target}`,
      );
    }

    const nextVersion = order.version + 1;
    const occurredAt = new Date().toISOString();
    const deadline =
      input.outcome.kind === 'RESERVED'
        ? new Date(Date.now() + input.acceptanceWindowMs).toISOString()
        : null;
    const rejectionReason = input.outcome.kind === 'REJECTED' ? input.outcome.reason : null;
    const available =
      input.outcome.kind === 'REJECTED' && 'available' in input.outcome
        ? (input.outcome.available ?? null)
        : null;
    await tx.query(
      `UPDATE orders
          SET status = $2, rejection_reason = $3, available_at_rejection = $4,
              acceptance_deadline_at = $5, version = $6, updated_at = $7
        WHERE order_id = $1`,
      [input.orderId, target, rejectionReason, available, deadline, nextVersion, occurredAt],
    );
    await tx.query(
      `INSERT INTO order_status_history
         (history_id, order_id, previous_status, new_status, action, actor_type, actor_id,
          order_version, occurred_at)
       VALUES ($1, $2, 'PENDING_CREDIT', $3, $4, 'CREDIT_SERVICE', 'credit-service', $5, $6)`,
      [
        randomUUID(),
        input.orderId,
        target,
        input.outcome.kind === 'RESERVED' ? 'CREDIT_RESERVED' : 'CREDIT_REJECTED',
        nextVersion,
        occurredAt,
      ],
    );
    await insertOutboxEvent(tx, {
      eventType: EVENTS.ORDER_STATUS_CHANGED,
      aggregateId: input.orderId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      payload: {
        orderId: input.orderId,
        previousStatus: 'PENDING_CREDIT',
        newStatus: target,
        occurredAt,
      },
    });
    return true;
  }

  async accept(
    orderId: string,
    courierId: string,
    expectedVersion: number,
    correlationId: string,
  ): Promise<{ accepted: true; order: OrderRow } | { accepted: false; order?: OrderRow }> {
    return this.db.transaction(async (tx) => {
      const updated = await tx.query<StoredOrder>(
        `UPDATE orders
            SET courier_id = $2, status = 'ACCEPTED', version = version + 1,
                accepted_at = now(), updated_at = now()
          WHERE order_id = $1
            AND status = 'OPEN'
            AND version = $3
            AND requester_id <> $2
            AND acceptance_deadline_at > now()
        RETURNING ${ORDER_COLUMNS}`,
        [orderId, courierId, expectedVersion],
      );
      if (!updated.rows[0]) {
        return { accepted: false, order: await this.findByIdUsing(tx, orderId) };
      }

      const order = mapOrder(updated.rows[0]);
      const occurredAt = order.updatedAt;
      await tx.query(
        `INSERT INTO order_status_history
           (history_id, order_id, previous_status, new_status, action, actor_type, actor_id,
            order_version, occurred_at)
         VALUES ($1, $2, 'OPEN', 'ACCEPTED', 'ACCEPT', 'STUDENT', $3, $4, $5)`,
        [randomUUID(), orderId, courierId, order.version, occurredAt],
      );
      await insertOutboxEvent(tx, {
        eventType: EVENTS.ORDER_STATUS_CHANGED,
        aggregateId: orderId,
        correlationId,
        payload: {
          orderId,
          previousStatus: 'OPEN',
          newStatus: 'ACCEPTED',
          occurredAt,
        },
      });
      return { accepted: true, order };
    });
  }

  /**
   * The single path for every lifecycle command after acceptance. It locks the row, resolves the
   * caller's role relative to the order, asks the executable transition table for a decision and,
   * only if one exists, applies it with a version-checked update, an immutable history row and
   * every emitted event in the same transaction. A refused command changes nothing.
   */
  async transition(command: TransitionCommand, tx?: Queryable): Promise<TransitionResult> {
    if (tx) return this.transitionUsing(tx, command);
    return this.db.transaction((inner) => this.transitionUsing(inner, command));
  }

  private async transitionUsing(
    tx: Queryable,
    command: TransitionCommand,
  ): Promise<TransitionResult> {
    const locked = await tx.query<StoredOrder>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE order_id = $1 FOR UPDATE`,
      [command.orderId],
    );
    if (!locked.rows[0]) return { kind: 'rejected', reason: 'NOT_FOUND' };
    const order = mapOrder(locked.rows[0]);
    const actor = resolveActor(order, command.actor);
    const now = command.now ?? new Date();
    const context = {
      acceptanceDeadlinePassed:
        order.acceptanceDeadlineAt !== null && new Date(order.acceptanceDeadlineAt) <= now,
      releaseReason: order.releaseReason ?? undefined,
    };

    const decision = decideTransition(order.status, command.action, actor, context);
    if (!decision) {
      const allowedSomewhere = ORDER_TRANSITIONS.some(
        (rule) => rule.action === command.action && rule.actors.includes(actor),
      );
      return {
        kind: 'rejected',
        reason: allowedSomewhere ? 'INVALID_STATE' : 'FORBIDDEN',
        order,
      };
    }
    if (command.expectedVersion !== undefined && command.expectedVersion !== order.version) {
      return { kind: 'rejected', reason: 'VERSION_CONFLICT', order };
    }
    command.verify?.(order);

    const occurredAt = now.toISOString();
    const patch: Record<string, unknown> = {
      status: decision.to,
      version: order.version + 1,
      updated_at: occurredAt,
      ...(decision.releaseReason ? { release_reason: decision.releaseReason } : {}),
      ...timestampPatch(command.action, decision, occurredAt),
      ...(command.patch ?? {}),
    };
    const columns = Object.keys(patch);
    const updated = await tx.query<StoredOrder>(
      `UPDATE orders
          SET ${columns.map((column, index) => `${column} = $${index + 3}`).join(', ')}
        WHERE order_id = $1 AND version = $2
        RETURNING ${ORDER_COLUMNS}`,
      [order.orderId, order.version, ...columns.map((column) => patch[column])],
    );
    const next = updated.rows[0] ? mapOrder(updated.rows[0]) : undefined;
    if (!next) return { kind: 'rejected', reason: 'VERSION_CONFLICT', order };

    await tx.query(
      `INSERT INTO order_status_history
         (history_id, order_id, previous_status, new_status, action, actor_type, actor_id,
          order_version, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        order.orderId,
        order.status,
        next.status,
        command.action,
        HISTORY_ACTOR[actor],
        command.actor.id,
        next.version,
        occurredAt,
      ],
    );
    await command.afterApply?.(tx, next);
    for (const eventType of decision.emitted) {
      await insertOutboxEvent(tx, {
        ...emittedEvent(eventType, order, next, occurredAt),
        aggregateId: order.orderId,
        correlationId: command.correlationId,
        ...(command.causationId ? { causationId: command.causationId } : {}),
      } as Parameters<typeof insertOutboxEvent>[1]);
    }
    return { kind: 'applied', order: next, decision };
  }

  async insertReceipt(tx: Queryable, order: OrderRow): Promise<void> {
    await tx.query(
      `INSERT INTO order_receipts
         (order_id, requester_id, courier_id, supplier_snapshot, reward, credit_transaction_id,
          created_at, accepted_at, picked_up_at, delivered_at, completion_requested_at, completed_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        order.orderId,
        order.requesterId,
        order.courierId,
        JSON.stringify(order.supplierSnapshot),
        order.reward,
        order.creditTransactionId,
        order.createdAt,
        order.acceptedAt,
        order.pickedUpAt,
        order.deliveredAt,
        order.completionRequestedAt,
        order.completedAt,
      ],
    );
  }

  async findReceipt(orderId: string): Promise<OrderReceipt | undefined> {
    const result = await this.db.query<
      Row & {
        order_id: string;
        requester_id: string;
        courier_id: string;
        supplier_snapshot: SupplierSnapshot;
        reward: number;
        credit_transaction_id: string;
        created_at: Date | string;
        accepted_at: Date | string;
        picked_up_at: Date | string;
        delivered_at: Date | string;
        completion_requested_at: Date | string;
        completed_at: Date | string;
      }
    >(`SELECT * FROM order_receipts WHERE order_id = $1`, [orderId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      orderId: row.order_id,
      requesterId: row.requester_id,
      courierId: row.courier_id,
      supplier: row.supplier_snapshot,
      reward: Number(row.reward),
      creditTransactionId: row.credit_transaction_id,
      timestamps: {
        createdAt: iso(row.created_at),
        acceptedAt: iso(row.accepted_at),
        pickedUpAt: iso(row.picked_up_at),
        deliveredAt: iso(row.delivered_at),
        completionRequestedAt: iso(row.completion_requested_at),
        completedAt: iso(row.completed_at),
      },
    };
  }
}

/** Who is asking: a person (resolved against the order) or a system actor. */
export type CommandActor =
  | { kind: 'USER'; id: string; isAdmin: boolean }
  | { kind: 'SYSTEM'; id: string | null }
  | { kind: 'CREDIT_SERVICE'; id: 'credit-service' };

export interface TransitionCommand {
  orderId: string;
  action: OrderAction;
  actor: CommandActor;
  /** Participant commands must state the version they observed; system commands omit it. */
  expectedVersion?: number;
  correlationId: string;
  causationId?: string;
  now?: Date;
  /** Throws to refuse the command after the transition is known to be legal (e.g. reply facts). */
  verify?: (order: OrderRow) => void;
  /** Extra column values written with the transition. */
  patch?: Record<string, unknown>;
  /** Extra writes in the same transaction, after the history row. */
  afterApply?: (tx: Queryable, order: OrderRow) => Promise<void>;
}

export type TransitionResult =
  | { kind: 'applied'; order: OrderRow; decision: TransitionDecision }
  | {
      kind: 'rejected';
      reason: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_STATE' | 'VERSION_CONFLICT';
      order?: OrderRow;
    };

const HISTORY_ACTOR: Record<OrderActor, string> = {
  REQUESTER: 'REQUESTER',
  ASSIGNED_COURIER: 'COURIER',
  OTHER_STUDENT: 'STUDENT',
  ADMIN: 'ADMIN',
  CREDIT_SERVICE: 'CREDIT_SERVICE',
  SYSTEM: 'SYSTEM',
};

/** A requester or courier acts as that participant even if they are also an administrator. */
function resolveActor(order: OrderRow, actor: CommandActor): OrderActor {
  if (actor.kind === 'SYSTEM') return 'SYSTEM';
  if (actor.kind === 'CREDIT_SERVICE') return 'CREDIT_SERVICE';
  if (actor.id === order.requesterId) return 'REQUESTER';
  if (order.courierId !== null && actor.id === order.courierId) return 'ASSIGNED_COURIER';
  return actor.isAdmin ? 'ADMIN' : 'OTHER_STUDENT';
}

function timestampPatch(
  action: OrderAction,
  decision: TransitionDecision,
  at: string,
): Record<string, unknown> {
  // A withdrawing or timed-out courier loses the errand (and with it, private access to it).
  const courierRemoved =
    action === 'WITHDRAW' || action === 'PICKUP_TIMEOUT'
      ? { courier_id: null, accepted_at: null }
      : {};
  if (action === 'RECORD_PICKUP') return { picked_up_at: at };
  if (action === 'RECORD_DELIVERY') return { delivered_at: at };
  if (decision.to === 'COMPLETION_PENDING_CREDIT') return { completion_requested_at: at };
  if (decision.to === 'COMPLETED') return { completed_at: at };
  if (decision.to === 'RELEASE_PENDING_CREDIT') {
    return { ...courierRemoved, release_requested_at: at };
  }
  if (decision.to === 'CANCELLED' || decision.to === 'EXPIRED') return { released_at: at };
  return courierRemoved;
}

function emittedEvent(eventType: string, before: OrderRow, after: OrderRow, occurredAt: string) {
  if (eventType === EVENTS.ORDER_STATUS_CHANGED) {
    return {
      eventType: EVENTS.ORDER_STATUS_CHANGED,
      payload: {
        orderId: after.orderId,
        previousStatus: before.status,
        newStatus: after.status,
        occurredAt,
      },
    };
  }
  if (eventType === EVENTS.ORDER_COMPLETION_REQUESTED) {
    if (!after.courierId) throw new Error('completion requested without an assigned courier');
    return {
      eventType: EVENTS.ORDER_COMPLETION_REQUESTED,
      payload: {
        orderId: after.orderId,
        requesterId: after.requesterId,
        courierId: after.courierId,
        amount: after.reward,
      },
    };
  }
  if (eventType === EVENTS.CREDIT_RELEASE_REQUESTED) {
    return {
      eventType: EVENTS.CREDIT_RELEASE_REQUESTED,
      payload: { orderId: after.orderId, requesterId: after.requesterId, amount: after.reward },
    };
  }
  throw new Error(`transition emits an uncatalogued event: ${eventType}`);
}

export type PendingCreditStatus =
  'PENDING_CREDIT' | 'COMPLETION_PENDING_CREDIT' | 'RELEASE_PENDING_CREDIT';

/** The exact request an order in a *_PENDING_CREDIT state is waiting on, for re-issue. */
function creditRequest(order: OrderRow) {
  if (order.status === 'PENDING_CREDIT') {
    return {
      eventType: EVENTS.CREDIT_RESERVATION_REQUESTED,
      payload: { orderId: order.orderId, requesterId: order.requesterId, amount: order.reward },
    };
  }
  if (order.status === 'COMPLETION_PENDING_CREDIT') {
    return emittedEvent(EVENTS.ORDER_COMPLETION_REQUESTED, order, order, order.updatedAt);
  }
  if (order.status === 'RELEASE_PENDING_CREDIT') {
    return emittedEvent(EVENTS.CREDIT_RELEASE_REQUESTED, order, order, order.updatedAt);
  }
  throw new Error(`order in ${order.status} is not waiting on a Credit request`);
}
