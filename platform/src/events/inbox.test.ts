import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db, Queryable, Row } from '../db.js';
import { EVENTS, type UserActivatedPayload } from './catalogue.js';
import { createEnvelope, type Envelope } from './envelope.js';
import { INBOX_TABLE_SQL, processOnce, withInbox } from './inbox.js';

/** The inbox table plus a stand-in for a consumer's own state: one wallet per activation. */
async function consumerDb(): Promise<Db> {
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
  await db.exec(INBOX_TABLE_SQL);
  // Deliberately no unique constraint: the inbox alone must prevent a second wallet.
  await db.exec('CREATE TABLE wallets (user_id text NOT NULL, balance int NOT NULL)');
  return db;
}

const activation = (userId = 'user-1'): Envelope<UserActivatedPayload> =>
  createEnvelope({
    eventType: EVENTS.USER_ACTIVATED,
    schemaVersion: 1,
    aggregateId: userId,
    producer: 'user-service',
    correlationId: 'corr-1',
    payload: { userId, activatedAt: new Date().toISOString() },
  });

const issueWallet = async (tx: Queryable, userId: string) => {
  await tx.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 10)', [userId]);
};

const wallets = async (db: Db) =>
  (await db.query<{ user_id: string }>('SELECT user_id FROM wallets')).rows;

const context = { attempt: 1, queue: 'foc.credit.wallet-provisioning' };

beforeAll(() => {
  Logger.overrideLogger(false);
});

describe('processOnce', () => {
  it('turns 100 deliveries of one event into one local effect', async () => {
    const db = await consumerDb();
    const event = activation();

    // All at once, as a redelivery storm would arrive. PGlite runs one
    // transaction at a time, so these serialize on the connection; on real
    // PostgreSQL they would serialize on the inbox's primary key instead.
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        processOnce(db, 'wallets', event, (tx) => issueWallet(tx, event.payload.userId)),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await wallets(db)).toHaveLength(1);
    await db.close();
  });

  it('rolls the inbox record back with a failed effect, so a redelivery still applies it', async () => {
    const db = await consumerDb();
    const event = activation();

    await expect(
      processOnce(db, 'wallets', event, async (tx) => {
        await issueWallet(tx, event.payload.userId);
        throw new Error('ledger unavailable');
      }),
    ).rejects.toThrow('ledger unavailable');
    expect(await wallets(db)).toHaveLength(0);

    expect(await processOnce(db, 'wallets', event, (tx) => issueWallet(tx, 'user-1'))).toBe(true);
    expect(await wallets(db)).toHaveLength(1);
    await db.close();
  });

  it('keeps consumers apart: each applies an event once, independently', async () => {
    const db = await consumerDb();
    const event = activation();
    const apply = (consumer: string) =>
      processOnce(db, consumer, event, (tx) => issueWallet(tx, consumer));

    expect(await apply('wallets')).toBe(true);
    expect(await apply('welcome-email')).toBe(true);
    expect(await apply('wallets')).toBe(false);
    expect((await wallets(db)).map((w) => w.user_id).sort()).toEqual(['wallets', 'welcome-email']);
    await db.close();
  });

  it('applies distinct events, even for the same aggregate', async () => {
    const db = await consumerDb();
    const first = activation('user-1');
    const second = { ...activation('user-1'), eventId: randomUUID() };

    await processOnce(db, 'wallets', first, (tx) => issueWallet(tx, 'user-1'));
    await processOnce(db, 'wallets', second, (tx) => issueWallet(tx, 'user-1'));
    expect(await wallets(db)).toHaveLength(2);
    await db.close();
  });
});

describe('withInbox', () => {
  it('gives an EventConsumer handler the transaction, and skips duplicates before it runs', async () => {
    const db = await consumerDb();
    const event = activation();
    let calls = 0;
    const handler = withInbox<UserActivatedPayload>(db, 'wallets', async (e, tx, ctx) => {
      calls += 1;
      expect(ctx.queue).toBe(context.queue);
      await issueWallet(tx, e.payload.userId);
    });

    for (let i = 0; i < 100; i++) await handler(event, { ...context, attempt: i + 1 });

    expect(calls).toBe(1);
    expect(await wallets(db)).toEqual([{ user_id: 'user-1' }]);
    await db.close();
  });

  it('lets a failing handler throw to the consumer, which then retries it', async () => {
    const db = await consumerDb();
    const event = activation();
    let attempts = 0;
    const handler = withInbox<UserActivatedPayload>(db, 'wallets', async (e, tx) => {
      attempts += 1;
      await issueWallet(tx, e.payload.userId);
      if (attempts === 1) throw new Error('transient');
    });

    await expect(handler(event, context)).rejects.toThrow('transient');
    await handler(event, { ...context, attempt: 2 });
    await handler(event, { ...context, attempt: 3 });

    expect(attempts).toBe(2);
    expect(await wallets(db)).toHaveLength(1);
    await db.close();
  });
});
