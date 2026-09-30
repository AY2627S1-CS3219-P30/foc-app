import type { OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import type { Logger as PinoLogger } from 'pino';

/**
 * The narrow database port the service codes against. Production uses `pg`
 * (see {@link PgDb}); tests run the same SQL on PGlite, which is real PostgreSQL
 * compiled to WASM, so no server is needed to run the suite.
 */
export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs several statements with no parameters (used by migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs `fn` in one transaction: commits if it resolves, rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgDbOptions {
  /**
   * Where pool-level errors go. Pass the service's `LOGGER` so they land in the
   * structured log stream; without one they fall back to the console.
   */
  logger?: Pick<PinoLogger, 'error'>;
}

/**
 * PostgreSQL implementation of {@link Db}. The pool connects lazily, on first
 * query, and is drained when Nest shuts the application down.
 */
export class PgDb implements Db, OnApplicationShutdown {
  private readonly pool: pg.Pool;
  private closed = false;

  constructor(connectionString: string, options: PgDbOptions = {}) {
    this.pool = new pg.Pool({ connectionString, max: 10 });

    // node-postgres emits 'error' on the pool when an *idle* client's connection
    // drops out from under us (Postgres restart, network blip). That event fires
    // outside any query's promise, so with no listener it is an unhandled
    // EventEmitter error and Node exits the whole process. Log and swallow it:
    // the broken client is discarded automatically, and the next query
    // transparently opens a fresh connection.
    this.pool.on('error', (err) => {
      const message = 'Idle Postgres client error (connection dropped, will reconnect)';
      if (options.logger) options.logger.error({ err }, message);
      else console.error(`${message}: ${err.message}`);
    });
  }

  async query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Queryable = {
      query: async <R extends Row = Row>(sql: string, params?: unknown[]) => {
        const res = await client.query(sql, params);
        return { rows: res.rows as R[] };
      },
      exec: async (sql) => {
        await client.query(sql);
      },
    };
    // Set when the connection itself is unusable, so it is destroyed rather than
    // handed back to the pool for the next request to fail on.
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async close(): Promise<void> {
    // `pool.end()` throws if called twice; shutdown and a test may both close.
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  /** Nest calls this on shutdown (signal hooks are on via `startService`). */
  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}

/**
 * One forward-only migration. Kept as a TypeScript string rather than a .sql
 * file so `tsc` carries it into `dist/` with no copy step. The actual list of
 * migrations is service-specific (each service owns its schema); pass it to
 * {@link runMigrations}.
 */
export interface Migration {
  id: string;
  sql: string;
}

/**
 * Serializes migration runs across instances of the same service. It is a
 * transaction-scoped advisory lock, so it is released at each commit and never
 * outlives a crashed instance.
 */
const MIGRATION_LOCK = `SELECT pg_advisory_xact_lock(hashtext('foc.schema_migrations'))`;

/**
 * Applies every migration in `list` not yet recorded, in order, each in its own
 * transaction. Returns the ids this call applied. Forward-only: there is no
 * down step.
 *
 * Safe when several instances boot at once: each migration takes the lock and
 * re-checks the ledger inside its transaction, so an instance that waited on
 * another skips what that one already applied instead of failing on it.
 */
export async function runMigrations(db: Db, list: Migration[]): Promise<string[]> {
  await db.transaction(async (tx) => {
    await tx.query(MIGRATION_LOCK);
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });
  const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
  const done = new Set(rows.map((r) => r.id));
  const applied: string[] = [];

  for (const migration of list) {
    if (done.has(migration.id)) continue;
    const ran = await db.transaction(async (tx) => {
      await tx.query(MIGRATION_LOCK);
      const recorded = await tx.query('SELECT 1 FROM schema_migrations WHERE id = $1', [
        migration.id,
      ]);
      if (recorded.rows.length > 0) return false;
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      return true;
    });
    if (ran) applied.push(migration.id);
  }
  return applied;
}
