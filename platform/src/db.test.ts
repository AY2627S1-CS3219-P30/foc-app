import 'reflect-metadata';
import { EventEmitter as EventEmitterForTest, type EventEmitter } from 'node:events';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDb } from './db.js';

/** Never contacted: the pool connects lazily and these tests stub or skip every query. */
const UNUSED_URL = 'postgres://unused:unused@127.0.0.1:1/unused';

/** The private pool, so a test can emit the events node-postgres would. */
const poolOf = (db: PgDb) =>
  (db as unknown as { pool: EventEmitter & Record<string, unknown> }).pool;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PgDb idle-client errors', () => {
  it('routes a dropped idle connection to the logger instead of crashing', async () => {
    const logger = { error: vi.fn() };
    const db = new PgDb(UNUSED_URL, { logger });

    // With no 'error' listener, EventEmitter#emit('error') throws — that throw is the crash.
    expect(() => poolOf(db).emit('error', new Error('connection terminated'))).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      expect.stringContaining('Idle Postgres client error'),
    );
    await db.close();
  });

  it('falls back to the console when no logger is given', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = new PgDb(UNUSED_URL);

    expect(() => poolOf(db).emit('error', new Error('connection terminated'))).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('connection terminated'));
    await db.close();
  });
});

describe('PgDb.transaction', () => {
  /** Stubs the pool with one client whose queries follow `onQuery`. */
  function withClient(db: PgDb, onQuery: (sql: string) => Promise<unknown>) {
    const release = vi.fn();
    poolOf(db).connect = async () => ({
      query: (sql: string) => onQuery(sql),
      release,
    });
    return release;
  }

  it('returns a healthy client to the pool after a normal rollback', async () => {
    const db = new PgDb(UNUSED_URL);
    const release = withClient(db, async () => ({ rows: [] }));

    await expect(
      db.transaction(async () => {
        throw new Error('business rule');
      }),
    ).rejects.toThrow('business rule');
    expect(release).toHaveBeenCalledWith(undefined);
    await db.close();
  });

  it('destroys the client when ROLLBACK itself fails', async () => {
    const db = new PgDb(UNUSED_URL);
    const rollbackFailure = new Error('connection terminated');
    const release = withClient(db, async (sql) => {
      if (sql === 'ROLLBACK') throw rollbackFailure;
      return { rows: [] };
    });

    // The caller still sees the original error, not the rollback's.
    await expect(
      db.transaction(async () => {
        throw new Error('query failed');
      }),
    ).rejects.toThrow('query failed');
    expect(release).toHaveBeenCalledWith(rollbackFailure);
    await db.close();
  });
});

describe('PgDb shutdown', () => {
  it('drains the pool when Nest shuts the application down', async () => {
    const close = vi.spyOn(PgDb.prototype, 'close');
    class DbModule {}
    Module({ providers: [{ provide: 'DB', useFactory: () => new PgDb(UNUSED_URL) }] })(DbModule);

    const app = await NestFactory.createApplicationContext(DbModule, { logger: false });
    await app.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('tolerates being closed twice', async () => {
    const db = new PgDb(UNUSED_URL);
    await db.close();
    await expect(db.close()).resolves.toBeUndefined();
  });
});

describe('PgDb as a dependency of /health (PL-NFR3.1.2)', () => {
  it('is the mandatory dependency named database', async () => {
    const db = new PgDb(UNUSED_URL);
    expect(db).toMatchObject({ healthName: 'database', mandatory: true });
    await db.close();
  });

  it('answers its health check with one round trip to the server', async () => {
    const db = new PgDb(UNUSED_URL);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    poolOf(db).query = query;

    await expect(db.checkHealth()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith('SELECT 1');
    await db.close();
  });

  it('fails its health check when nothing answers at the address', async () => {
    const db = new PgDb(UNUSED_URL);
    await expect(db.checkHealth()).rejects.toThrow(/ECONNREFUSED/);
    await db.close();
  });
});

describe('PgDb when the server goes away mid-transaction (PL-NFR3.1.2)', () => {
  it('does not let a checked-out client’s lost connection end the process', async () => {
    const db = new PgDb(UNUSED_URL);
    // node-postgres emits 'error' on a client whose connection the server ended, whether or not
    // a query is running. In a transaction nobody else is listening, and an 'error' event with
    // no listener is an uncaught exception.
    const client = new EventEmitterForTest();
    poolOf(db).emit('connect', client);

    expect(() =>
      client.emit('error', new Error('terminating connection due to administrator command')),
    ).not.toThrow();
    await db.close();
  });
});
