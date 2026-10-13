import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable, Row } from '@foc/platform';

export class PgliteDb implements Db {
  private constructor(readonly client: PGlite) {}

  static async create(): Promise<PgliteDb> {
    return new PgliteDb(await PGlite.create());
  }

  async query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const result = await this.client.query<T>(sql, params);
    return { rows: result.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.client.transaction(async (transaction) =>
      fn({
        query: async <R extends Row = Row>(sql: string, params?: unknown[]) => {
          const result = await transaction.query<R>(sql, params);
          return { rows: result.rows };
        },
        exec: async (sql) => {
          await transaction.exec(sql);
        },
      }),
    );
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
