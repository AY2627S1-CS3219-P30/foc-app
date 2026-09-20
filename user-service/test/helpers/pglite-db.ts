import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable, Row } from '../../src/db/db.js';

/**
 * Runs the service's real SQL on PGlite (PostgreSQL compiled to WASM), so the
 * suite exercises actual constraints, unique indexes and transactions without
 * needing a database server or Docker.
 */
export class PgliteDb implements Db {
  private constructor(private readonly pg: PGlite) {}

  static async create(): Promise<PgliteDb> {
    return new PgliteDb(await PGlite.create());
  }

  async query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const res = await this.pg.query<T>(sql, params);
    return { rows: res.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (t) =>
      fn({
        query: async <R extends Row = Row>(sql: string, params?: unknown[]) => {
          const res = await t.query<R>(sql, params);
          return { rows: res.rows };
        },
        exec: async (sql) => {
          await t.exec(sql);
        },
      }),
    );
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
