import type { OnApplicationShutdown } from '@nestjs/common';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import type { Logger as PinoLogger } from 'pino';
import type { HealthIndicator } from './health.controller.js';

/**
 * The Drizzle handle a service's repositories code against. Widened over
 * {@link PgQueryResultHKT} so both the top-level database and a transaction
 * handle, over `pg` in production or PGlite in tests, satisfy it.
 */
export type DrizzleDatabase<TSchema extends Record<string, unknown> = Record<string, never>> =
  PgDatabase<PgQueryResultHKT, TSchema, ExtractTablesWithRelations<TSchema>>;

/**
 * The raw database port, for what Drizzle does not cover: migrations
 * (multi-statement DDL), the outbox relay, and raw assertions in tests.
 * Production uses `pg` (see {@link PgDb}); tests run the same SQL on PGlite,
 * which is real PostgreSQL compiled to WASM, so no server is needed.
 */
export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs several statements with no parameters (used by migrations). */
  exec(sql: string): Promise<void>;
}

/** Escapes LIKE metacharacters so user input matches literally (pair with `ESCAPE '\\'`). */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

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
 * query, and is drained when Nest shuts the application down. It is exposed so
 * a Drizzle instance can share it. `GET /health` asks it for a round trip, and
 * is `503` while that fails.
 */
export class PgDb implements Db, OnApplicationShutdown, HealthIndicator {
  /** A service cannot record anything without its database (PL-NFR3.1.2). */
  readonly healthName = 'database';
  readonly mandatory = true;

  readonly pool: pg.Pool;
  private closed = false;

  constructor(connectionString: string, options: PgDbOptions = {}) {
    // Without a connection timeout, a request made while the server is unreachable (rather than
    // refusing) would wait for ever instead of failing as unavailable.
    this.pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });

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

    // The pool listens only while a client is idle. A client that is checked out, in a
    // transaction, has no listener, and node-postgres emits 'error' on it when the server ends
    // the connection, running query or not: an uncaught exception that would exit the process
    // exactly when Postgres stops (PL-NFR3.1.2). Nothing to do here but not die. The statement
    // in flight, or the transaction's next one, fails and is reported by whoever ran it, and the
    // pool discards the client when it is released.
    this.pool.on('connect', (client) => {
      client.on('error', () => undefined);
    });
  }

  async query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  /** Asked by `GET /health`: one round trip to the server. */
  async checkHealth(): Promise<void> {
    await this.pool.query('SELECT 1');
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
