/**
 * The narrow database port the service codes against. Production uses `pg`
 * (see pg-db.ts); tests run the same SQL on PGlite, which is real PostgreSQL
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

export const DB = Symbol('DB');
