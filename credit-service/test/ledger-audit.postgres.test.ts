import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '@foc/test-harness';
import { CreditRepository } from '../src/credits/credit.repository.js';
import { LEDGER_AUDIT_LOCK, LedgerAuditService } from '../src/credits/ledger-audit.service.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;
suite('ledger audit concurrency and snapshot on real PostgreSQL', () => {
  let database: EphemeralPostgres;
  beforeEach(async () => {
    database = await createEphemeralPostgres({
      adminUrl: TEST_POSTGRES_URL!,
      label: 'ledger_audit',
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await database?.dispose();
  });

  it('does not overlap a scan already holding the database lock', async () => {
    let unlock!: () => void, acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const holder = database.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [LEDGER_AUDIT_LOCK]);
      acquired();
      await release;
    });
    await ready;
    try {
      expect(await new LedgerAuditService(database.db).run('MANUAL', 'admin')).toBeNull();
    } finally {
      unlock();
      await holder;
    }
    expect((await new LedgerAuditService(database.db).run('MANUAL', 'admin'))?.status).toBe('PASS');
  });

  it('takes one snapshot even if issuance commits after the audit begins', async () => {
    const db = database.db,
      credits = new CreditRepository(db);
    await db.transaction((tx) => credits.issueInitial(tx, 'first'));
    const originalTransaction = db.transaction.bind(db);
    let snapshotWallets = -1;
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((fn) =>
      originalTransaction(async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = async (sql, params) => {
          const result = await query(sql, params);
          if (sql.includes('pg_try_advisory_xact_lock')) {
            await originalTransaction((other) => credits.issueInitial(other, 'second'));
            const snapshot = await query<{ n: number; isolation: string }>(
              "SELECT (SELECT count(*)::int FROM wallets) AS n,current_setting('transaction_isolation') AS isolation",
            );
            snapshotWallets = snapshot.rows[0]!.n;
            expect(snapshot.rows[0]!.isolation).toBe('repeatable read');
          }
          return result;
        };
        return fn(tx);
      }),
    );
    expect((await new LedgerAuditService(db).run('CLI'))?.status).toBe('PASS');
    spy.mockRestore();
    expect(snapshotWallets).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM wallets')).rows[0]!.n).toBe(2);
  });

  it('permits only one scheduled-day result across concurrent replicas', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => new LedgerAuditService(database.db).run('SCHEDULED')),
    );
    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value?.status === 'PASS'),
    ).toHaveLength(1);
    expect(
      (
        await database.db.query(
          'SELECT count(*)::int AS n FROM ledger_audit_runs WHERE scheduled_day IS NOT NULL',
        )
      ).rows[0]!.n,
    ).toBe(1);
  });
});
