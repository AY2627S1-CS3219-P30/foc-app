import 'reflect-metadata';
import type { EventEmitter } from 'node:events';
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
