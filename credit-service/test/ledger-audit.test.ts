import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerAuditService } from '../src/credits/ledger-audit.service.js';
import { LedgerAuditScheduler } from '../src/credits/ledger-audit.scheduler.js';
import { walletLedgerViolations } from '../src/credits/invariants.js';
import { ContractValidator } from '@foc/test-harness';
import { Metrics } from '@foc/platform';
import { asAdmin, asStudent, createTestApp, http, issue, type TestApp } from './helpers/app.js';

describe('daily wallet-versus-ledger audit (CRD-10)', () => {
  let t: TestApp;
  let audit: LedgerAuditService;
  beforeEach(async () => {
    t = await createTestApp();
    audit = t.app.get(LedgerAuditService);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  it('has no result before a run, then records a clean scan without changing monetary rows', async () => {
    expect(
      (await http(t).get('/admin/ledger-audits/latest').set('Authorization', asAdmin).expect(200))
        .body,
    ).toEqual({ run: null });
    await issue(t, 'student-1');
    const before = await t.db.query('SELECT * FROM wallets');
    const response = await http(t)
      .post('/admin/ledger-audits/run')
      .set('Authorization', asAdmin)
      .expect(200);
    expect(response.body.run).toMatchObject({
      status: 'PASS',
      mismatchCount: 0,
      origin: 'MANUAL',
      requestedBy: 'admin-1',
    });
    expect(response.body.run.checks).toHaveLength(6);
    expect((await audit.latest())?.runId).toBe(response.body.run.runId);
    expect((await t.db.query('SELECT * FROM wallets')).rows).toEqual(before.rows);
    expect(
      (await t.db.query('SELECT count(*)::int AS n FROM credit_transactions')).rows[0]!.n,
    ).toBe(1);
  });

  it('catches per-wallet drift even when platform conservation still holds; never repairs it', async () => {
    await issue(t, 'student-1');
    await issue(t, 'student-2');
    await t.db.exec(
      "UPDATE wallets SET available=9 WHERE user_id='student-1'; UPDATE wallets SET available=11 WHERE user_id='student-2';",
    );
    const run = await audit.run('CLI');
    expect(run).toMatchObject({ status: 'MISMATCH', mismatchCount: 2 });
    expect(await walletLedgerViolations(t.db)).toHaveLength(2);
    const stored = await t.db.query<{ results: Array<{ name: string; violations: string[] }> }>(
      'SELECT results FROM ledger_audit_runs',
    );
    expect(stored.rows[0]!.results.flatMap((r) => r.violations).join(' ')).toContain('student-1');
    expect(JSON.stringify(run)).not.toContain('student-1'); // summary is not an unaudited wallet read
    expect(
      (await t.db.query("SELECT available FROM wallets WHERE user_id='student-1'")).rows[0]!
        .available,
    ).toBe(9);
  });

  it('detects a ledger row corrupted by an operator in an isolated test', async () => {
    await issue(t, 'student-1');
    // Production rejects this write. Only this disposable test temporarily disables that trigger.
    await t.db.exec('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only');
    await t.db.query("UPDATE ledger_entries SET amount=11 WHERE account='AVAILABLE'");
    await t.db.exec('ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only');
    const run = await audit.run('CLI');
    expect(run?.status).toBe('MISMATCH');
    expect(run?.checks.find((c) => c.name.includes('debits'))?.mismatchCount).toBe(1);
    expect(run?.checks.find((c) => c.name.includes('agree with their ledger'))?.mismatchCount).toBe(
      1,
    );
    const metrics = await http(t).get('/metrics').expect(200);
    expect(metrics.text).toContain(
      `foc_credit_ledger_audit_mismatches{service="credit-service"} ${run!.mismatchCount}`,
    );
    expect(
      (await t.db.query("SELECT amount FROM ledger_entries WHERE account='AVAILABLE'")).rows[0]!
        .amount,
    ).toBe(11);
  });

  it('checks all lifecycle movements against both ledger accounts', async () => {
    await issue(t, 'student-1');
    await issue(t, 'courier');
    const input = {
      requesterId: 'student-1',
      amount: 3,
      correlationId: 'audit-test',
      causationId: 'audit-test',
    };
    await t.db.transaction((tx) => t.credits.reserve(tx, { ...input, orderId: 'paid' }));
    expect((await audit.run('CLI'))?.status).toBe('PASS');
    await t.db.transaction((tx) =>
      t.credits.transfer(tx, { ...input, orderId: 'paid', courierId: 'courier' }),
    );
    await t.db.transaction((tx) => t.credits.reserve(tx, { ...input, orderId: 'cancel' }));
    await t.db.transaction((tx) => t.credits.release(tx, { ...input, orderId: 'cancel' }));
    expect((await audit.run('CLI'))?.status).toBe('PASS');
  });

  it('records at most one scheduled scan per UTC day, including across service instances', async () => {
    expect((await audit.run('SCHEDULED'))?.status).toBe('PASS');
    expect(await new LedgerAuditService(t.db).run('SCHEDULED')).toBeNull();
    expect((await audit.run('MANUAL', 'admin-1'))?.status).toBe('PASS');
    expect((await t.db.query('SELECT count(*)::int AS n FROM ledger_audit_runs')).rows[0]!.n).toBe(
      2,
    );
  });

  it('runs today even when a completed scheduled scan exists for yesterday', async () => {
    await t.db.query(`INSERT INTO ledger_audit_runs
      (run_id,origin,scheduled_day,status,mismatch_count,results,started_at,completed_at)
      VALUES (gen_random_uuid(),'SCHEDULED',
        to_char((now() AT TIME ZONE 'UTC') - interval '1 day','YYYY-MM-DD'),
        'PASS',0,'[]',now() - interval '1 day',now() - interval '1 day')`);
    expect((await audit.run('SCHEDULED'))?.status).toBe('PASS');
    expect(await audit.run('SCHEDULED')).toBeNull();
    expect((await t.db.query('SELECT count(*)::int AS n FROM ledger_audit_runs')).rows[0]!.n).toBe(
      2,
    );
  });

  it('preserves an ERROR attempt rather than reporting a failed scan as clean, and retries', async () => {
    const transaction = vi
      .spyOn(t.db, 'transaction')
      .mockRejectedValueOnce(new Error('injected scan failure'));
    await expect(audit.run('SCHEDULED')).rejects.toMatchObject({ code: 'LEDGER_AUDIT_FAILED' });
    expect(await audit.latest()).toMatchObject({
      status: 'ERROR',
      mismatchCount: null,
      checks: [],
    });
    transaction.mockRestore();
    expect((await audit.run('SCHEDULED'))?.status).toBe('PASS');
    expect((await t.db.query('SELECT count(*)::int AS n FROM ledger_audit_runs')).rows[0]!.n).toBe(
      2,
    );
  });

  it('protects every completed run and its findings against UPDATE, DELETE and TRUNCATE', async () => {
    await audit.run('CLI');
    await expect(
      t.db.query("UPDATE ledger_audit_runs SET status='ERROR',mismatch_count=NULL"),
    ).rejects.toThrow(/append-only/);
    await expect(t.db.query('DELETE FROM ledger_audit_runs')).rejects.toThrow(/append-only/);
    await expect(t.db.query('TRUNCATE ledger_audit_runs')).rejects.toThrow(/append-only/);
  });

  it('requires an administrator for both reading and starting an audit', async () => {
    for (const path of ['/admin/ledger-audits/latest', '/admin/ledger-audits/run']) {
      const req = () => (path.endsWith('/run') ? http(t).post(path) : http(t).get(path));
      await req().expect(401);
      await req().set('Authorization', asStudent).expect(403);
    }
    expect((await t.db.query('SELECT count(*)::int AS n FROM ledger_audit_runs')).rows[0]!.n).toBe(
      0,
    );
  });

  it('exports persisted mismatch metrics across instances and clears only after a complete clean scan', async () => {
    await issue(t, 'student-1');
    await t.db.query("UPDATE wallets SET available=9 WHERE user_id='student-1'");
    const run = await audit.run('CLI');
    // A fresh process/registry recovers the previous result from storage, not process memory.
    const restartedMetrics = new Metrics('credit-service');
    new LedgerAuditService(t.db, restartedMetrics);
    expect(await restartedMetrics.render()).toContain(
      `foc_credit_ledger_audit_mismatches{service="credit-service"} ${run!.mismatchCount}`,
    );
    let metrics = await http(t).get('/metrics').expect(200);
    expect(metrics.text).toContain(
      `foc_credit_ledger_audit_mismatches{service="credit-service"} ${run!.mismatchCount}`,
    );
    const transaction = vi
      .spyOn(t.db, 'transaction')
      .mockRejectedValueOnce(new Error('scan failed'));
    await expect(audit.run('CLI')).rejects.toBeDefined();
    transaction.mockRestore();
    metrics = await http(t).get('/metrics').expect(200);
    expect(metrics.text).toContain('foc_credit_ledger_audit_failed{service="credit-service"} 1');
    expect(metrics.text).toContain(
      `foc_credit_ledger_audit_mismatches{service="credit-service"} ${run!.mismatchCount}`,
    );
    await t.db.query("UPDATE wallets SET available=10 WHERE user_id='student-1'");
    await audit.run('CLI');
    metrics = await http(t).get('/metrics').expect(200);
    expect(metrics.text).toContain(
      'foc_credit_ledger_audit_mismatches{service="credit-service"} 0',
    );
    expect(metrics.text).toContain('foc_credit_ledger_audit_failed{service="credit-service"} 0');
  });

  it('honours both published contracts, including null, refusal, busy and failed-scan responses', async () => {
    const contract = ContractValidator.for('credit-service');
    const latest = '/admin/ledger-audits/latest',
      run = '/admin/ledger-audits/run';
    for (const [method, path] of [
      ['get', latest],
      ['post', run],
    ] as const) {
      const req = () => (method === 'get' ? http(t).get(path) : http(t).post(path));
      await contract.assert(method, path, await req().expect(401));
      await contract.assert(method, path, await req().set('Authorization', asStudent).expect(403));
      await contract.assert(method, path, await req().set('Authorization', asAdmin).expect(200));
    }
    const busy = vi.spyOn(audit, 'run').mockResolvedValueOnce(null);
    const busyResponse = await http(t).post(run).set('Authorization', asAdmin).expect(409);
    expect(busyResponse.body.error.code).toBe('LEDGER_AUDIT_BUSY');
    await contract.assert('post', run, busyResponse);
    busy.mockRestore();
    const failing = vi
      .spyOn(t.db, 'transaction')
      .mockRejectedValueOnce(new Error('test storage failure'));
    await contract.assert(
      'post',
      run,
      await http(t).post(run).set('Authorization', asAdmin).expect(503),
    );
    failing.mockRestore();
    await contract.assert(
      'get',
      latest,
      await http(t).get(latest).set('Authorization', asAdmin).expect(200),
    );
  });
});

describe('ledger audit scheduler', () => {
  afterEach(() => vi.useRealTimers());
  it('starts immediately, polls daily eligibility, retries failure and stops cleanly', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(null);
    const scheduler = new LedgerAuditScheduler({ run }, 1000);
    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledWith('SCHEDULED');
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
