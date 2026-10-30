/**
 * Nest DI token for the {@link PgDb} that owns the pool, reports the database to /health and
 * closes the pool on shutdown.
 */
export const RAW_DB = Symbol('RAW_DB');
