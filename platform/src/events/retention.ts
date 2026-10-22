import type { Db, Row } from '../db.js';

/**
 * PLT-12 (#287): how long the two event tables keep a row. Neither may simply grow for ever, and
 * neither may lose a row that something still depends on.
 */
export interface EventRetention {
  /**
   * Days a published outbox row is kept: the admin console's errand trace reads them, so this is
   * how far back a trace sees its events. An unpublished row is never pruned, however old.
   */
  outboxDays: number;
  /**
   * Days an inbox row is kept to recognise a repeat. A copy can arrive long after the first: the
   * relay publishes, then the broker goes away before the row is marked, and the copy is sent when
   * it is back. A row is also kept while a copy of its event waits as a dead letter, which an
   * operator may redrive at any time.
   */
  inboxDays: number;
}

export const DEFAULT_EVENT_RETENTION: EventRetention = { outboxDays: 30, inboxDays: 30 };

/** Rows deleted per statement, so a large backlog never holds one long lock. */
const BATCH_SIZE = 1_000;

const exists = async (db: Db, table: string) =>
  (await db.query<{ name: string | null } & Row>(`SELECT to_regclass($1)::text AS name`, [table]))
    .rows[0]?.name != null;

/** Runs a `... RETURNING 1` delete of at most `batch` rows until one deletes fewer. */
async function deleteInBatches(db: Db, sql: string, days: number, batch: number): Promise<number> {
  let total = 0;
  for (;;) {
    const { rows } = await db.query<{ n: number } & Row>(sql, [days, batch]);
    const deleted = rows[0]?.n ?? 0;
    total += deleted;
    if (deleted < batch) return total;
  }
}

/**
 * Deletes published outbox rows and inbox rows past their retention, in batches, and returns how
 * many went from each. A table the service does not have is skipped; so is the dead-letter check
 * when the service keeps no dead letters.
 */
export async function pruneEventTables(
  db: Db,
  retention: EventRetention = DEFAULT_EVENT_RETENTION,
  batchSize = BATCH_SIZE,
): Promise<{ outbox: number; inbox: number }> {
  const outbox = (await exists(db, 'outbox_events'))
    ? await deleteInBatches(
        db,
        `WITH gone AS (
           DELETE FROM outbox_events WHERE id IN (
             SELECT id FROM outbox_events
              WHERE published_at IS NOT NULL AND published_at < now() - make_interval(days => $1)
              LIMIT $2
                FOR UPDATE SKIP LOCKED)
           RETURNING 1)
         SELECT count(*)::int AS n FROM gone`,
        retention.outboxDays,
        batchSize,
      )
    : 0;

  let inbox = 0;
  if (await exists(db, 'processed_events')) {
    const waiting = (await exists(db, 'dead_letters'))
      ? `AND NOT EXISTS (SELECT 1 FROM dead_letters d
                          WHERE d.event_id = processed_events.event_id::text
                            AND d.redriven_at IS NULL)`
      : '';
    inbox = await deleteInBatches(
      db,
      `WITH gone AS (
         DELETE FROM processed_events WHERE (consumer, event_id) IN (
           SELECT consumer, event_id FROM processed_events
            WHERE processed_at < now() - make_interval(days => $1) ${waiting}
            LIMIT $2)
         RETURNING 1)
       SELECT count(*)::int AS n FROM gone`,
      retention.inboxDays,
      batchSize,
    );
  }
  return { outbox, inbox };
}
