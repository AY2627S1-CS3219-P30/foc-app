import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db, Queryable, Row } from '../db.js';
import { Metrics } from '../metrics.js';
import { INBOX_TABLE_SQL } from './inbox.js';
import { OUTBOX_TABLE_SQL } from './outbox.js';
import { EventTablePruner } from './pruner.js';

/** The real outbox and inbox on PGlite (PostgreSQL compiled to WASM). */
async function eventDb(): Promise<Db> {
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
  await db.exec(OUTBOX_TABLE_SQL);
  await db.exec(INBOX_TABLE_SQL);
  return db;
}

/** A published outbox row and an inbox row, both 35 days old: past the default 30 days. */
async function oldRows(db: Db) {
  await db.query(
    `INSERT INTO outbox_events (id, event_type, aggregate_id, payload, correlation_id, occurred_at, published_at)
     VALUES ($1, 'user.activated', 'u-1', '{}', 'c-1', now() - interval '40 days', now() - interval '35 days')`,
    [randomUUID()],
  );
  await db.query(
    `INSERT INTO processed_events (consumer, event_id, event_type, processed_at)
     VALUES ('wallets', $1, 'user.activated', now() - interval '35 days')`,
    [randomUUID()],
  );
}

const count = async (db: Db, table: string) =>
  (await db.query<{ n: number } & Row>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
const quietLogger = () => ({ log: vi.fn(), warn: vi.fn() });

let db: Db | undefined;
let pruner: EventTablePruner | undefined;
afterEach(async () => {
  await pruner?.stop();
  await db?.close();
  pruner = db = undefined;
});

describe('EventTablePruner (PLT-12)', () => {
  it('prunes on a timer of its own: soon after start, then every intervalMs', async () => {
    db = await eventDb();
    const metrics = new Metrics('test-service');
    pruner = new EventTablePruner({ db, intervalMs: 50, logger: quietLogger(), metrics });
    await oldRows(db);

    pruner.start();
    await vi.waitFor(async () => expect(await count(db!, 'outbox_events')).toBe(0));
    expect(await count(db, 'processed_events')).toBe(0);

    await oldRows(db);
    await vi.waitFor(async () => expect(await count(db!, 'processed_events')).toBe(0));
    const rendered = await metrics.render();
    expect(rendered).toMatch(/^foc_event_rows_pruned_total\{[^}]*table="outbox_events"[^}]*\} 2$/m);
    expect(rendered).toMatch(
      /^foc_event_rows_pruned_total\{[^}]*table="processed_events"[^}]*\} 2$/m,
    );
  });

  it('lets the process exit: its timer holds nothing open', async () => {
    db = await eventDb();
    const unref = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => ({
      unref,
      ref: vi.fn(),
      hasRef: () => false,
      fn,
    })) as unknown as typeof setTimeout);
    try {
      pruner = new EventTablePruner({ db, logger: quietLogger() });
      pruner.start();
      expect(unref).toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('stops after the batch in hand when the service shuts down', async () => {
    const real = await eventDb();
    db = real;
    for (let i = 0; i < 3; i++) await oldRows(real);
    let stopping: Promise<void> | undefined;
    const slow: Db = {
      ...real,
      query: async (sql, params) => {
        const result = await real.query(sql, params);
        // Shut down as the first batch of deletes comes back.
        if (sql.includes('DELETE FROM outbox_events') && !stopping) stopping = pruner!.stop();
        return result;
      },
    };
    pruner = new EventTablePruner({ db: slow, batchSize: 1, logger: quietLogger() });

    await pruner.prune();
    await stopping;

    expect(await count(real, 'outbox_events')).toBe(2);
    expect(await count(real, 'processed_events')).toBe(3);
  });

  it('counts what went when a later statement fails, and logs the error itself', async () => {
    const real = await eventDb();
    db = real;
    await oldRows(real);
    const failing: Db = {
      ...real,
      query: async (sql, params) => {
        if (sql.includes('DELETE FROM processed_events')) throw new Error('inbox broke');
        return real.query(sql, params);
      },
    };
    const logger = quietLogger();
    const metrics = new Metrics('test-service');
    pruner = new EventTablePruner({ db: failing, logger, metrics });

    await pruner.prune();

    expect(await metrics.render()).toMatch(
      /^foc_event_rows_pruned_total\{[^}]*table="outbox_events"[^}]*\} 1$/m,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: 'inbox broke' }),
        outbox: 1,
        inbox: 0,
        msg: 'pruning the event tables failed; will retry',
      }),
    );
  });
});
