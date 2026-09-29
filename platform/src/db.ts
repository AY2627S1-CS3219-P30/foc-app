import pg from 'pg';

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

/** PostgreSQL implementation of {@link Db}. The pool connects lazily, on first query. */
export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });

    // node-postgres emits 'error' on the pool when an *idle* client's connection
    // drops out from under us (Postgres restart, network blip). That event fires
    // outside any query's promise, so with no listener it is an unhandled
    // EventEmitter error and Node exits the whole process. Log and swallow it:
    // the broken client is discarded automatically, and the next query
    // transparently opens a fresh connection. This runs with no request context,
    // and PgDb is built by a useFactory with no logger injected, so — like the
    // pre-logger startup path in main.ts — console is the available sink.
    this.pool.on('error', (err) => {
      console.error(
        `Idle Postgres client error (connection dropped, will reconnect): ${err.message}`,
      );
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
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
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
 * Applies every migration in `list` not yet recorded, in order, each in its own
 * transaction. Returns the ids applied. Forward-only: there is no down step.
 */
export async function runMigrations(db: Db, list: Migration[]): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
  const done = new Set(rows.map((r) => r.id));
  const applied: string[] = [];

  for (const migration of list) {
    if (done.has(migration.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
    });
    applied.push(migration.id);
  }
  return applied;
}
