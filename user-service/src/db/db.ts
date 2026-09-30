import type { SQL } from 'drizzle-orm';
import type { DrizzleDatabase } from '@foc/platform';
import type * as schema from './schema.js';

/**
 * The Drizzle handle the service codes against. It covers both the top-level
 * instance and a transaction handle, so a repository function can run
 * standalone or inside `db.transaction(...)`.
 */
export type Database = DrizzleDatabase<typeof schema>;

/**
 * Runs a statement the query builder cannot express and returns its rows. Both
 * drivers return `rows`; the driver-agnostic `execute` types the result as unknown.
 */
export async function execute<T = unknown>(db: Database, query: SQL): Promise<T[]> {
  return ((await db.execute(query)) as { rows: T[] }).rows;
}

/**
 * Nest DI tokens. Kept in the service layer (a Nest concern, not shared
 * runtime). `DB` is the Drizzle {@link Database}; `RAW_DB` is the raw `Db` port
 * it shares a pool with, for the outbox relay. Tests override
 * both with PGlite.
 */
export const DB = Symbol('DB');
export const RAW_DB = Symbol('RAW_DB');
