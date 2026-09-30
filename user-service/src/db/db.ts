import type { DrizzleDatabase } from '@foc/platform';
import type * as schema from './schema.js';

/**
 * The Drizzle handle the service codes against. It covers both the top-level
 * instance and a transaction handle, so a repository function can run
 * standalone or inside `db.transaction(...)`.
 */
export type Database = DrizzleDatabase<typeof schema>;

/**
 * Nest DI tokens. Kept in the service layer (a Nest concern, not shared
 * runtime). `DB` is the Drizzle {@link Database}; `RAW_DB` is the raw `Db` port
 * it shares a pool with, for migrations and the outbox relay. Tests override
 * both with PGlite.
 */
export const DB = Symbol('DB');
export const RAW_DB = Symbol('RAW_DB');
