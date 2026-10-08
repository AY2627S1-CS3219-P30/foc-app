import { Inject, Injectable } from '@nestjs/common';
import type { Row } from '@foc/platform';
import { ORDER_DB, type OrderDatabase } from '../db/db.js';

const iso = (value: Date | string): string => new Date(value).toISOString();
const nullableIso = (value: Date | string | null): string | null => (value ? iso(value) : null);

/**
 * PLT-05 (EI-NFR4.1.1) — what an operator reads to follow one errand: everything the Order Service
 * recorded about it. Read-only; the Credit Service's half is its own endpoint.
 */
@Injectable()
export class OperationsRepository {
  constructor(@Inject(ORDER_DB) private readonly db: OrderDatabase) {}

  /** The errand, its state changes, the events it caused, reconciliation and alerts. */
  async timeline(orderId: string) {
    const order = await this.db.query<
      {
        order_id: string;
        requester_id: string;
        courier_id: string | null;
        status: string;
        reward: number;
        version: number;
        credit_transaction_id: string | null;
        created_at: Date | string;
        updated_at: Date | string;
      } & Row
    >(
      `SELECT order_id, requester_id, courier_id, status, reward, version, credit_transaction_id,
              created_at, updated_at
         FROM orders WHERE order_id = $1`,
      [orderId],
    );
    const row = order.rows[0];
    if (!row) return undefined;

    const [history, events, reconciliation, alerts] = await Promise.all([
      this.db.query<
        {
          previous_status: string | null;
          new_status: string;
          action: string;
          actor_type: string;
          actor_id: string | null;
          order_version: number;
          occurred_at: Date | string;
        } & Row
      >(
        `SELECT previous_status, new_status, action, actor_type, actor_id, order_version, occurred_at
           FROM order_status_history WHERE order_id = $1 ORDER BY order_version`,
        [orderId],
      ),
      // Every event the errand caused, sent or still waiting, with how its sending went.
      this.db.query<
        {
          id: string;
          event_type: string;
          correlation_id: string;
          causation_id: string | null;
          occurred_at: Date | string;
          published_at: Date | string | null;
          attempts: number;
          last_error: string | null;
        } & Row
      >(
        `SELECT id, event_type, correlation_id, causation_id, occurred_at, published_at, attempts,
                last_error
           FROM outbox_events WHERE aggregate_id = $1 ORDER BY seq`,
        [orderId],
      ),
      this.db.query<
        {
          attempt_id: string;
          run_id: string;
          order_status: string;
          credit_status: string | null;
          action: string;
          reissued_event_id: string | null;
          attempted_at: Date | string;
        } & Row
      >(
        `SELECT attempt_id, run_id, order_status, credit_status, action, reissued_event_id, attempted_at
           FROM order_reconciliation_attempts WHERE order_id = $1 ORDER BY attempted_at, attempt_id`,
        [orderId],
      ),
      this.db.query<{ kind: string; raised_at: Date | string; detail: unknown } & Row>(
        `SELECT kind, raised_at, detail FROM order_operator_alerts WHERE order_id = $1 ORDER BY raised_at`,
        [orderId],
      ),
    ]);

    return {
      orderId: row.order_id,
      status: row.status,
      requesterId: row.requester_id,
      courierId: row.courier_id,
      reward: Number(row.reward),
      version: Number(row.version),
      creditTransactionId: row.credit_transaction_id,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      history: history.rows.map((h) => ({
        previousStatus: h.previous_status,
        newStatus: h.new_status,
        action: h.action,
        actorType: h.actor_type,
        actorId: h.actor_id,
        version: Number(h.order_version),
        occurredAt: iso(h.occurred_at),
      })),
      events: events.rows.map((e) => ({
        eventId: e.id,
        eventType: e.event_type,
        correlationId: e.correlation_id,
        causationId: e.causation_id,
        occurredAt: iso(e.occurred_at),
        publishedAt: nullableIso(e.published_at),
        attempts: Number(e.attempts),
        lastError: e.last_error,
      })),
      reconciliation: reconciliation.rows.map((r) => ({
        attemptId: r.attempt_id,
        runId: r.run_id,
        orderStatus: r.order_status,
        creditStatus: r.credit_status,
        action: r.action,
        reissuedEventId: r.reissued_event_id,
        attemptedAt: iso(r.attempted_at),
      })),
      alerts: alerts.rows.map((a) => ({
        kind: a.kind,
        raisedAt: iso(a.raised_at),
        detail: a.detail,
      })),
    };
  }

  /** Operator alerts across every errand, newest first: waits on Credit past the limit, and conflicts. */
  async alerts(limit = 100) {
    const result = await this.db.query<
      { order_id: string; kind: string; raised_at: Date | string; detail: unknown } & Row
    >(
      `SELECT order_id, kind, raised_at, detail FROM order_operator_alerts
        ORDER BY raised_at DESC, order_id, kind LIMIT $1`,
      [limit],
    );
    return {
      items: result.rows.map((a) => ({
        orderId: a.order_id,
        kind: a.kind,
        raisedAt: iso(a.raised_at),
        detail: a.detail,
      })),
    };
  }
}
