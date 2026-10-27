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

/**
 * The indexes the prune finds its rows through, for a service to add in a migration of its own
 * (`OUTBOX_TABLE_SQL` and `INBOX_TABLE_SQL` are frozen). Without them each batch reads the whole
 * table from the start, so a first prune of a large backlog reads it over and over. The services
 * declare the same indexes, by these names, in their Drizzle schemas.
 */
export const OUTBOX_RETENTION_INDEX_SQL = `
  CREATE INDEX outbox_events_published_idx ON outbox_events (published_at)
    WHERE published_at IS NOT NULL;
`;
export const INBOX_RETENTION_INDEX_SQL = `
  CREATE INDEX processed_events_processed_idx ON processed_events (processed_at);
`;

export type PrunedTable = 'outbox_events' | 'processed_events';

export interface PruneOptions {
  /** Rows per statement. Default 1,000. */
  batchSize?: number;
  /** Asked before each batch: once it says true, the prune ends after the batch in hand. */
  shouldStop?: () => boolean;
  /** Told what each batch deleted, as it happens, so a later failure loses no count. */
  onDeleted?: (table: PrunedTable, rows: number) => void;
}

const exists = async (db: Db, table: string) =>
  (await db.query<{ name: string | null } & Row>(`SELECT to_regclass($1)::text AS name`, [table]))
    .rows[0]?.name != null;

/**
 * Runs a `... RETURNING 1` delete of at most `batch` rows until one deletes nothing. A short batch
 * is not the end: another instance pruning at once holds some rows, which both selects skip.
 */
async function deleteInBatches(
  db: Db,
  table: PrunedTable,
  sql: string,
  days: number,
  { batchSize = BATCH_SIZE, shouldStop = () => false, onDeleted }: PruneOptions,
): Promise<number> {
  let total = 0;
  while (!shouldStop()) {
    const { rows } = await db.query<{ n: number } & Row>(sql, [days, batchSize]);
    const deleted = rows[0]?.n ?? 0;
    if (deleted === 0) break;
    total += deleted;
    onDeleted?.(table, deleted);
  }
  return total;
}

/**
 * Deletes published outbox rows and inbox rows past their retention, in batches, and returns how
 * many went from each. A table the service does not have is skipped; so is the dead-letter check
 * when the service keeps no dead letters. Retention may be a fraction of a day.
 */
export async function pruneEventTables(
  db: Db,
  retention: EventRetention = DEFAULT_EVENT_RETENTION,
  options: PruneOptions = {},
): Promise<{ outbox: number; inbox: number }> {
  const outbox = (await exists(db, 'outbox_events'))
    ? await deleteInBatches(
        db,
        'outbox_events',
        `WITH gone AS (
           DELETE FROM outbox_events WHERE id IN (
             SELECT id FROM outbox_events
              WHERE published_at IS NOT NULL AND published_at < now() - $1::float8 * interval '1 day'
              LIMIT $2
                FOR UPDATE SKIP LOCKED)
           RETURNING 1)
         SELECT count(*)::int AS n FROM gone`,
        retention.outboxDays,
        options,
      )
    : 0;

  let inbox = 0;
  if (!options.shouldStop?.() && (await exists(db, 'processed_events'))) {
    const waiting = (await exists(db, 'dead_letters'))
      ? `AND NOT EXISTS (SELECT 1 FROM dead_letters d
                          WHERE d.event_id = processed_events.event_id::text
                            AND d.redriven_at IS NULL)`
      : '';
    inbox = await deleteInBatches(
      db,
      'processed_events',
      `WITH gone AS (
         DELETE FROM processed_events WHERE (consumer, event_id) IN (
           SELECT consumer, event_id FROM processed_events
            WHERE processed_at < now() - $1::float8 * interval '1 day' ${waiting}
            LIMIT $2
              FOR UPDATE SKIP LOCKED)
         RETURNING 1)
       SELECT count(*)::int AS n FROM gone`,
      retention.inboxDays,
      options,
    );
  }
  return { outbox, inbox };
}
