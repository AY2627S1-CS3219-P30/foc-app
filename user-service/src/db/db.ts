// The database port (Db / Queryable / Row), the PgDb implementation, and
// runMigrations now live in @foc/platform so there is one source of truth
// across services. Re-exported here so existing '../db/db.js' import sites keep
// working, and so the Nest DI token below sits next to the types it injects.
export { type Db, type Queryable, type Row } from '@foc/platform';

/**
 * Nest DI token for the {@link Db} port. Kept in the service layer (a Nest
 * concern, not shared runtime): the service binds it to a PgDb in production
 * and overrides it with a PGlite-backed Db in tests.
 */
export const DB = Symbol('DB');
