import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CREDIT_STATUS_READER,
  CreditUnavailableError,
  reconciliationDecision,
  type CreditStatus,
  type CreditStatusReader,
} from './credit-status.client.js';
import { OrdersRepository } from './orders.repository.js';

export const CREDIT_RECONCILER_OPTIONS = Symbol('CREDIT_RECONCILER_OPTIONS');

export interface CreditReconcilerOptions {
  /** An order waiting on Credit longer than this is a candidate (CREDIT_WAIT_TIMEOUT_MS). */
  staleAfterMs: number;
  /** The least time between two attempts for one order (RECONCILE_RETRY_MS). */
  retryAfterMs: number;
  intervalMs: number;
  batchSize?: number;
}

export interface ReconciliationRun {
  runId: string;
  candidates: number;
  reissued: number;
  alerted: number;
  creditUnavailable: number;
  skipped: number;
  durationMs: number;
}

/**
 * CRD-07 credit reconciliation, hosted by Order (owner decision, 2026-10-01). It finds orders stuck
 * in a *_PENDING_CREDIT state, reads Credit's authoritative status for each, and repairs only by
 * writing the same idempotent request to the outbox again; Credit applies each operation at most
 * once per order and answers a repeat with the recorded result. It never touches balances — Order
 * has none — and never moves an order itself: only Credit's reply does.
 *
 * A combination that re-issuing cannot fix (for example a release pending for money Credit already
 * transferred) raises one CREDIT_STATE_CONFLICT operator alert. Every decision is recorded, and the
 * row lock plus the retry window mean overlapping runs, in one process or several, act once.
 */
@Injectable()
export class CreditReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CreditReconciler.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<ReconciliationRun>;

  constructor(
    @Inject(OrdersRepository) private readonly orders: OrdersRepository,
    @Inject(CREDIT_STATUS_READER) private readonly credit: CreditStatusReader,
    @Inject(CREDIT_RECONCILER_OPTIONS) private readonly options: CreditReconcilerOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = this.run();
    try {
      await this.running;
    } catch (err) {
      this.logger.error({ err, msg: 'credit reconciliation run failed; will retry next interval' });
    } finally {
      this.running = undefined;
    }
  }

  async run(): Promise<ReconciliationRun> {
    const started = Date.now();
    const runId = randomUUID();
    // Times are compared inside PostgreSQL, at its own precision, against its own clock.
    const candidates = await this.orders.findReconciliationCandidates(
      this.options.staleAfterMs,
      this.options.retryAfterMs,
      this.options.batchSize ?? 100,
    );
    const metrics: ReconciliationRun = {
      runId,
      candidates: candidates.length,
      reissued: 0,
      alerted: 0,
      creditUnavailable: 0,
      skipped: 0,
      durationMs: 0,
    };

    for (const candidate of candidates) {
      let credit: CreditStatus | null = null;
      try {
        // The run's ID, as on any request it re-issues: one run reads as one trace.
        credit = await this.credit.status(candidate.orderId, `reconcile-${runId}`);
      } catch (error) {
        if (!(error instanceof CreditUnavailableError)) throw error;
      }
      const action = credit
        ? reconciliationDecision(candidate.status, credit.status)
        : 'CREDIT_UNAVAILABLE';
      const recorded = await this.orders.recordReconciliation({
        orderId: candidate.orderId,
        observed: candidate,
        runId,
        retryAfterMs: this.options.retryAfterMs,
        credit,
        action,
        correlationId: `reconcile-${runId}`,
      });
      if (!recorded) {
        metrics.skipped += 1;
        continue;
      }
      const entry = {
        runId,
        orderId: candidate.orderId,
        orderStatus: candidate.status,
        creditStatus: credit?.status ?? null,
        creditDetail: credit?.detail ?? null,
      };
      if (recorded.action === 'REISSUED') {
        metrics.reissued += 1;
        this.logger.log({ ...entry, eventId: recorded.eventId, msg: 'credit request re-issued' });
      } else if (recorded.action === 'ALERTED') {
        metrics.alerted += 1;
        if (recorded.alertRaised) {
          this.logger.warn({
            ...entry,
            alert: 'CREDIT_STATE_CONFLICT',
            msg: 'Order and Credit disagree; operator attention needed',
          });
        }
      } else {
        metrics.creditUnavailable += 1;
        this.logger.warn({ ...entry, msg: 'Credit status unavailable; nothing repaired' });
      }
    }

    metrics.durationMs = Date.now() - started;
    this.logger.log({ ...metrics, msg: 'credit reconciliation run' });
    return metrics;
  }
}
