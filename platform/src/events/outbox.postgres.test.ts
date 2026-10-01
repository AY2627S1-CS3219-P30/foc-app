import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgDb } from '../db.js';
import { EVENTS } from './catalogue.js';
import type { EventPublisher } from './publisher.js';
import { OUTBOX_TABLE_SQL, OutboxRelay, insertOutboxEvent } from './outbox.js';

/**
 * Relays racing on real PostgreSQL, where claims genuinely overlap and
 * `FOR UPDATE SKIP LOCKED` does the work. PGlite runs one transaction at a
 * time, so outbox.test.ts cannot show this. Skipped unless a database is given:
 *
 *   docker compose up -d postgres
 *   TEST_POSTGRES_URL=postgres://postgres:postgres_dev@localhost:55432/postgres npm test -w @foc/platform
 *
 * Everything happens in a throwaway schema, dropped afterwards.
 */
// TEST_DATABASE_URL is the variable's earlier name, still honoured for existing shells.
const DATABASE = process.env.TEST_POSTGRES_URL ?? process.env.TEST_DATABASE_URL;
const suite = DATABASE ? describe : describe.skip;

const SCHEMA = `outbox_test_${Math.random().toString(36).slice(2, 8)}`;
const RELAYS = 4;
const AGGREGATES = 10;
const EVENTS_WRITTEN = 200;

suite('outbox relay on PostgreSQL', () => {
  let admin: PgDb;
  let db: PgDb;

  beforeAll(async () => {
    admin = new PgDb(DATABASE as string);
    await admin.exec(`CREATE SCHEMA ${SCHEMA}`);
    const scoped = new URL(DATABASE as string);
    scoped.searchParams.set('options', `-c search_path=${SCHEMA}`);
    db = new PgDb(scoped.toString());
    await db.exec(OUTBOX_TABLE_SQL);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.close();
  });

  it('lets several relays drain one outbox at once: every row once, each aggregate in order', async () => {
    const written: Array<{ id: string; aggregateId: string }> = [];
    for (let i = 0; i < EVENTS_WRITTEN; i++) {
      const aggregateId = `user-${i % AGGREGATES}`;
      const id = await db.transaction((tx) =>
        insertOutboxEvent(tx, {
          eventType: EVENTS.USER_SUSPENDED,
          aggregateId,
          correlationId: `corr-${i}`,
          payload: {
            userId: aggregateId,
            status: 'SUSPENDED',
            occurredAt: new Date().toISOString(),
          },
        }),
      );
      written.push({ id, aggregateId });
    }

    const sent: Array<{ id: string; aggregateId: string }> = [];
    // Takes an uneven moment per message, so claims overlap and finish out of
    // step: without the per-aggregate rule, two relays holding events for the
    // same aggregate would publish them out of order.
    const publisher = {
      publish: async (input: { eventId?: string; aggregateId: string }) => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 4));
        sent.push({ id: input.eventId as string, aggregateId: input.aggregateId });
      },
    } as unknown as EventPublisher;
    const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const relays = Array.from(
      { length: RELAYS },
      () => new OutboxRelay({ db, publisher, batchSize: 5, logger: quiet }),
    );

    // Each relay drains until nothing is claimable by it. One that found
    // everything locked by the others may stop first, so go round again until
    // the backlog is empty.
    for (let round = 0; round < 20; round++) {
      await Promise.all(relays.map((r) => r.tick()));
      const { rows } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL',
      );
      if (rows[0]!.n === 0) break;
    }

    expect(sent).toHaveLength(EVENTS_WRITTEN);
    expect(new Set(sent.map((s) => s.id)).size).toBe(EVENTS_WRITTEN);
    expect(relays.filter((r) => r.stats.published > 0).length).toBeGreaterThan(1);
    for (let a = 0; a < AGGREGATES; a++) {
      const of = (list: typeof sent) =>
        list.filter((e) => e.aggregateId === `user-${a}`).map((e) => e.id);
      expect(of(sent)).toEqual(of(written));
    }
  });
});
