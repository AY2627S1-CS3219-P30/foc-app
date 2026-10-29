import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ApiException,
  METRICS,
  errorMessage,
  type Db,
  type Metrics,
  type Row,
} from '@foc/platform';
import { RAW_DB } from '../db/db.js';
import { CREDIT_INVARIANTS, walletLedgerViolations } from './invariants.js';

export type AuditOrigin = 'SCHEDULED' | 'MANUAL' | 'CLI';
export type AuditStatus = 'PASS' | 'MISMATCH' | 'ERROR';
type Finding = { name: string; violations: string[] };
type AuditRow = Row & {
  run_id: string;
  origin: AuditOrigin;
  requested_by: string | null;
  status: AuditStatus;
  mismatch_count: number | null;
  results: Finding[];
  error: string | null;
  started_at: Date | string;
  completed_at: Date | string;
};

/** Public summaries intentionally omit wallet IDs/balances; detailed findings stay in the audit DB. */
export const auditSummary = (row: AuditRow) => ({
  runId: row.run_id,
  origin: row.origin,
  requestedBy: row.requested_by,
  status: row.status,
  mismatchCount: row.mismatch_count,
  error: row.error,
  startedAt: new Date(row.started_at).toISOString(),
  completedAt: new Date(row.completed_at).toISOString(),
  checks: row.results.map((r) => ({ name: r.name, mismatchCount: r.violations.length })),
});
export type LedgerAuditSummary = ReturnType<typeof auditSummary>;
export const LEDGER_AUDIT_LOCK = 283_010;

/** Read-only economy inspection; its only writes are append-only audit results. */
@Injectable()
export class LedgerAuditService {
  private readonly logger = new Logger(LedgerAuditService.name);

  constructor(
    @Inject(RAW_DB) private readonly db: Db,
    @Optional() @Inject(METRICS) metrics?: Metrics,
  ) {
    const gauges = [
      [
        'foc_credit_ledger_audit_mismatches',
        'Mismatches in the last completed ledger audit.',
        'mismatches',
      ],
      [
        'foc_credit_ledger_audit_failed',
        'Whether the last ledger audit failed to complete.',
        'failed',
      ],
      [
        'foc_credit_ledger_audit_last_completed_timestamp_seconds',
        'Time of the last complete ledger scan, including one with mismatches.',
        'completed',
      ],
    ] as const;
    for (const [name, help, field] of gauges) {
      metrics?.addGauge({
        name,
        help,
        collect: async (set) => {
          const { rows } = await this.db.query<
            Row & { mismatches: number; failed: number; completed: string }
          >(
            `SELECT coalesce((SELECT mismatch_count FROM ledger_audit_runs WHERE status <> 'ERROR' ORDER BY completed_at DESC,run_id DESC LIMIT 1),0) AS mismatches,
                  coalesce((SELECT CASE WHEN status='ERROR' THEN 1 ELSE 0 END FROM ledger_audit_runs ORDER BY completed_at DESC,run_id DESC LIMIT 1),0) AS failed,
                  coalesce((SELECT extract(epoch FROM completed_at) FROM ledger_audit_runs WHERE status <> 'ERROR' ORDER BY completed_at DESC,run_id DESC LIMIT 1),0) AS completed`,
          );
          set({}, Number(rows[0]![field]));
        },
      });
    }
  }

  async latest(): Promise<LedgerAuditSummary | null> {
    try {
      const { rows } = await this.db.query<AuditRow>(
        'SELECT * FROM ledger_audit_runs ORDER BY completed_at DESC,run_id DESC LIMIT 1',
      );
      return rows[0] ? auditSummary(rows[0]) : null;
    } catch {
      throw new ApiException(
        503,
        'LEDGER_AUDIT_UNAVAILABLE',
        'Ledger audit history is temporarily unavailable.',
      );
    }
  }

  /** One UTC scheduled run per day across replicas; manual/CLI scans can run again after a fix. */
  async run(
    origin: AuditOrigin,
    requestedBy: string | null = null,
  ): Promise<LedgerAuditSummary | null> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    try {
      const result = await this.db.transaction(async (tx) => {
        // All checks must see the same committed state, even while normal money operations run.
        await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const lock = await tx.query<Row & { acquired: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1) AS acquired',
          [LEDGER_AUDIT_LOCK],
        );
        if (!lock.rows[0]!.acquired) return null;
        let scheduledDay: string | null = null;
        if (origin === 'SCHEDULED') {
          const day = await tx.query<Row & { day: string }>(
            "SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
          );
          scheduledDay = day.rows[0]!.day;
          const prior = await tx.query(
            'SELECT run_id FROM ledger_audit_runs WHERE scheduled_day=$1',
            [scheduledDay],
          );
          if (prior.rows.length) return null;
        }
        const results: Finding[] = [];
        for (const [name, check] of Object.entries({
          ...CREDIT_INVARIANTS,
          'wallet balances agree with their ledger': walletLedgerViolations,
        })) {
          results.push({ name, violations: await check(tx) });
        }
        const count = results.reduce((sum, r) => sum + r.violations.length, 0);
        const { rows } = await tx.query<AuditRow>(
          `INSERT INTO ledger_audit_runs (run_id,origin,requested_by,scheduled_day,status,mismatch_count,results,started_at,completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,clock_timestamp())
           ON CONFLICT (scheduled_day) DO NOTHING RETURNING *`,
          [
            runId,
            origin,
            requestedBy,
            scheduledDay,
            count ? 'MISMATCH' : 'PASS',
            count,
            JSON.stringify(results),
            startedAt,
          ],
        );
        if (!rows[0]) return null;
        return auditSummary(rows[0]);
      });
      // Log success only after commit. Never put wallet balances/findings in general service logs.
      if (result)
        this.logger[result.status === 'MISMATCH' ? 'warn' : 'log']({
          runId,
          origin,
          mismatchCount: result.mismatchCount,
          msg: 'credit ledger audit completed',
        });
      return result;
    } catch (err) {
      this.logger.error({ runId, reason: errorMessage(err), msg: 'credit ledger audit failed' });
      // The failed transaction rolled back. Preserve an ERROR attempt when storage still works;
      // it has no scheduled_day, so the next scheduler poll retries rather than skipping the day.
      try {
        await this.db.query(
          `INSERT INTO ledger_audit_runs (run_id,origin,requested_by,status,mismatch_count,results,error,started_at,completed_at)
           VALUES ($1,$2,$3,'ERROR',NULL,'[]','Audit could not complete; inspect the service logs using the run ID.',$4,clock_timestamp())`,
          [runId, origin, requestedBy, startedAt],
        );
      } catch {
        this.logger.error({ runId, msg: 'could not persist failed ledger audit attempt' });
      }
      throw new ApiException(503, 'LEDGER_AUDIT_FAILED', 'The ledger audit could not complete.', {
        runId,
      });
    }
  }
}
