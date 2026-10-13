import { Logger } from '@nestjs/common';
import type { Db, Queryable } from '../db.js';
import type { EventHandler, HandlerContext } from './consumer.js';
import type { Envelope } from './envelope.js';

/**
 * The transactional inbox (EVT-02): the consuming half of at-least-once
 * delivery.
 *
 * The same event can arrive more than once — the outbox relay republishes after
 * a crash, and the broker redelivers when an acknowledgement is lost — always
 * with the same eventId. A consumer records that id in the same transaction as
 * the event's local effect, so the effect happens once however many copies
 * arrive.
 */

const logger = new Logger('Inbox');

/**
 * The inbox table, for a service to include in one of its own migrations:
 *
 *   { id: '003_inbox', sql: INBOX_TABLE_SQL }
 *
 * Frozen, like `OUTBOX_TABLE_SQL`. Keyed by consumer as well as event, so
 * two handlers in one service that both react to an event each apply it once.
 */
export const INBOX_TABLE_SQL = `
  CREATE TABLE processed_events (
    consumer     text NOT NULL,
    event_id     uuid NOT NULL,
    event_type   text NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
  );
`;

/**
 * Runs `effect` for an event unless `consumer` has already applied it. Returns
 * false, having done nothing, for a duplicate.
 *
 * The event id is inserted first, in the effect's own transaction. If the
 * effect throws, both roll back and a redelivery runs it again. If two copies
 * are handled at once, on two instances, the second insert waits on the first
 * transaction's primary key and then conflicts, so it is skipped rather than
 * applied twice.
 *
 * An effect that answers with an event of its own writes it with
 * `insertOutboxEvent(tx, …)`: the reply, the state change and the inbox record
 * then commit together, or not at all.
 */
export async function processOnce(
  db: Db,
  consumer: string,
  event: Pick<Envelope, 'eventId' | 'eventType'> & Partial<Pick<Envelope, 'correlationId'>>,
  effect: (tx: Queryable) => Promise<void> | void,
): Promise<boolean> {
  const applied = await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO processed_events (consumer, event_id, event_type)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [consumer, event.eventId, event.eventType],
    );
    if (rows.length === 0) return false;
    await effect(tx);
    return true;
  });
  if (!applied) {
    logger.log({
      correlationId: event.correlationId,
      consumer,
      eventId: event.eventId,
      eventType: event.eventType,
      msg: 'duplicate event skipped',
    });
  }
  return applied;
}

export type InboxHandler<T> = (
  envelope: Envelope<T>,
  tx: Queryable,
  context: HandlerContext,
) => Promise<void> | void;

/**
 * Wraps a handler so it runs through the inbox, for use as an EventConsumer
 * handler:
 *
 *   await consumer.subscribe({
 *     queue: WALLET_QUEUE,
 *     eventType: EVENTS.USER_ACTIVATED,
 *     payloadSchema: userActivatedPayload,
 *     handler: withInbox(db, WALLET_QUEUE, (event, tx) => wallets.issue(tx, event.payload)),
 *   });
 *
 * The handler writes through `tx`. If it throws, the consumer retries as usual,
 * and its writes and the inbox record have rolled back together.
 */
export function withInbox<T>(db: Db, consumer: string, handler: InboxHandler<T>): EventHandler<T> {
  return async (envelope, context) => {
    await processOnce(db, consumer, envelope, (tx) => handler(envelope, tx, context));
  };
}

/**
 * Records the inbox id but invokes an idempotent command handler on every
 * delivery, including a delivery whose event id was already committed.
 *
 * Use this only when the handler has a separate business key and persists its
 * result. It exists for request/reply sagas: if a reply was published but lost,
 * redelivering the same command must append another copy of the recorded reply
 * without applying the economic effect again. The inbox still participates in
 * the transaction and still distinguishes first delivery from transport replay
 * for operations and diagnostics.
 */
export async function processReplayable(
  db: Db,
  consumer: string,
  event: Pick<Envelope, 'eventId' | 'eventType'>,
  effect: (tx: Queryable, firstDelivery: boolean) => Promise<void> | void,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO processed_events (consumer, event_id, event_type)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [consumer, event.eventId, event.eventType],
    );
    const firstDelivery = rows.length > 0;
    await effect(tx, firstDelivery);
    return firstDelivery;
  });
}

export type ReplayableInboxHandler<T> = (
  envelope: Envelope<T>,
  tx: Queryable,
  context: HandlerContext,
  firstDelivery: boolean,
) => Promise<void> | void;

/** EventConsumer adapter for {@link processReplayable}. */
export function withReplayableInbox<T>(
  db: Db,
  consumer: string,
  handler: ReplayableInboxHandler<T>,
): EventHandler<T> {
  return async (envelope, context) => {
    await processReplayable(db, consumer, envelope, (tx, firstDelivery) =>
      handler(envelope, tx, context, firstDelivery),
    );
  };
}
