import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db, Queryable, Row } from '../db.js';
import { DEAD_LETTERS_TABLE_SQL } from './dead-letters.js';
import { createEnvelope } from './envelope.js';
import { INBOX_TABLE_SQL, withInbox } from './inbox.js';
import { OUTBOX_TABLE_SQL } from './outbox.js';
import { DEFAULT_EVENT_RETENTION, pruneEventTables } from './retention.js';

/** The real table SQL on PGlite (PostgreSQL compiled to WASM), with the tables asked for. */
async function eventDb(tables: string[]): Promise<Db> {
  const pg = await PGlite.create();
  const wrap = (q: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
    query: async <T extends Row = Row>(sql: string, params?: unknown[]) => ({
      rows: (await q.query<T>(sql, params)).rows,
    }),
    exec: async (sql) => {
      await q.exec(sql);
    },
  });
  const db: Db = {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
  for (const sql of tables) await db.exec(sql);
  return db;
}

let db: Db | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

/** An outbox row, published `publishedDaysAgo` days ago, or not at all when null. */
async function outboxRow(occurredDaysAgo: number, publishedDaysAgo: number | null) {
  const id = randomUUID();
  await db!.query(
    `INSERT INTO outbox_events (id, event_type, aggregate_id, payload, correlation_id, occurred_at, published_at)
     VALUES ($1, 'user.activated', 'u-1', '{}', 'c-1',
             now() - make_interval(days => $2),
             CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END)`,
    [id, occurredDaysAgo, publishedDaysAgo],
  );
  return id;
}

async function inboxRow(daysAgo: number, eventId = randomUUID()) {
  await db!.query(
    `INSERT INTO processed_events (consumer, event_id, event_type, processed_at)
     VALUES ('wallets', $1, 'user.activated', now() - make_interval(days => $2))`,
    [eventId, daysAgo],
  );
  return eventId;
}

async function deadLetter(eventId: string, redriven: boolean) {
  await db!.query(
    `INSERT INTO dead_letters (id, queue, event_id, attempts, body, properties, redriven_at, redriven_by, redrive_reason)
     VALUES ($1, 'q', $2, 5, '\\x00', '{}',
             CASE WHEN $3 THEN now() ELSE NULL END,
             CASE WHEN $3 THEN 'admin-1' ELSE NULL END,
             CASE WHEN $3 THEN 'fixed' ELSE NULL END)`,
    [randomUUID(), eventId, redriven],
  );
}

const ids = async (table: string, column: string) =>
  (await db!.query<{ id: string } & Row>(`SELECT ${column}::text AS id FROM ${table}`)).rows
    .map((r) => r.id)
    .sort();

describe('pruning the event tables (PLT-12)', () => {
  it('keeps 30 days of each by default', () => {
    expect(DEFAULT_EVENT_RETENTION).toEqual({ outboxDays: 30, inboxDays: 30 });
  });

  it('deletes published outbox rows past retention, and never an unpublished one', async () => {
    db = await eventDb([OUTBOX_TABLE_SQL, INBOX_TABLE_SQL]);
    await outboxRow(40, 31);
    const stuck = await outboxRow(60, null);
    const recent = await outboxRow(2, 1);

    const pruned = await pruneEventTables(db);

    expect(pruned).toEqual({ outbox: 1, inbox: 0 });
    expect(await ids('outbox_events', 'id')).toEqual([stuck, recent].sort());
  });

  it('deletes inbox rows past retention, and keeps the recent ones', async () => {
    db = await eventDb([OUTBOX_TABLE_SQL, INBOX_TABLE_SQL]);
    await inboxRow(31);
    const recent = await inboxRow(29);

    expect(await pruneEventTables(db)).toEqual({ outbox: 0, inbox: 1 });
    expect(await ids('processed_events', 'event_id')).toEqual([recent]);
  });

  it('keeps an inbox row while a copy of its event still waits as a dead letter', async () => {
    db = await eventDb([OUTBOX_TABLE_SQL, INBOX_TABLE_SQL, DEAD_LETTERS_TABLE_SQL]);
    const waiting = await inboxRow(90);
    const redriven = await inboxRow(90);
    await deadLetter(waiting, false);
    await deadLetter(redriven, true);

    expect(await pruneEventTables(db)).toEqual({ outbox: 0, inbox: 1 });
    // A redrive of the waiting copy must still find that the event was applied.
    expect(await ids('processed_events', 'event_id')).toEqual([waiting]);
  });

  it('deletes in batches until nothing past retention is left', async () => {
    db = await eventDb([OUTBOX_TABLE_SQL, INBOX_TABLE_SQL]);
    for (let i = 0; i < 5; i++) {
      await outboxRow(40, 35);
      await inboxRow(40);
    }

    expect(await pruneEventTables(db, DEFAULT_EVENT_RETENTION, 2)).toEqual({ outbox: 5, inbox: 5 });
    expect(await ids('outbox_events', 'id')).toEqual([]);
  });

  it('takes its windows from the caller', async () => {
    db = await eventDb([OUTBOX_TABLE_SQL, INBOX_TABLE_SQL]);
    await outboxRow(10, 8);
    await inboxRow(8);

    expect(await pruneEventTables(db, { outboxDays: 7, inboxDays: 7 })).toEqual({
      outbox: 1,
      inbox: 1,
    });
  });

  it('works for a service that has no inbox', async () => {
    db = await eventDb([OUTBOX_TABLE_SQL]);
    await outboxRow(40, 31);

    expect(await pruneEventTables(db)).toEqual({ outbox: 1, inbox: 0 });
  });

  it('never lets a redelivered event apply twice', async () => {
    db = await eventDb([OUTBOX_TABLE_SQL, INBOX_TABLE_SQL]);
    let applied = 0;
    const handler = withInbox(db, 'wallets', async () => {
      applied++;
    });
    const event = createEnvelope({
      eventType: 'user.activated',
      schemaVersion: 1,
      aggregateId: 'u-1',
      producer: 'user-service',
      correlationId: 'c-1',
      payload: { userId: 'u-1', activatedAt: new Date().toISOString() },
    });
    const onDuplicate = vi.fn();

    await handler(event, { attempt: 1, queue: 'q' });
    await pruneEventTables(db);
    await handler(event, { attempt: 1, queue: 'q', onDuplicate });

    expect(applied).toBe(1);
    expect(onDuplicate).toHaveBeenCalledOnce();
  });
});
