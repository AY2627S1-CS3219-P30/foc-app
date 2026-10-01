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
import type {
  OpenOrderSummary,
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
  created_at: Date | string;
  updated_at: Date | string;
};

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
      `SELECT order_id, requester_id, courier_id, referred_admin_id, supplier_snapshot, items, delivery_zone,
              delivery_instructions, reward, status, release_reason, rejection_reason,
              available_at_rejection, version, acceptance_deadline_at, created_at, updated_at
         FROM orders
        WHERE order_id = $1`,
      [orderId],
    );
    return result.rows[0] ? mapOrder(result.rows[0]) : undefined;
  }

  async listOpen(now = new Date()): Promise<OpenOrderSummary[]> {
    const result = await this.db.query<StoredOrder>(
      `SELECT order_id, requester_id, courier_id, referred_admin_id, supplier_snapshot, items,
              delivery_zone, delivery_instructions, reward, status, release_reason,
              rejection_reason, available_at_rejection, version, acceptance_deadline_at,
              created_at, updated_at
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
      `SELECT order_id, requester_id, courier_id, referred_admin_id, supplier_snapshot, items, delivery_zone,
              delivery_instructions, reward, status, release_reason, rejection_reason,
              available_at_rejection, version, acceptance_deadline_at, created_at, updated_at
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
                updated_at = now()
          WHERE order_id = $1
            AND status = 'OPEN'
            AND version = $3
            AND requester_id <> $2
            AND acceptance_deadline_at > now()
        RETURNING *`,
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
}
