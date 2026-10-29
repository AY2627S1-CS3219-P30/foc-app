import {
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { LedgerAuditService, LedgerAuditSummary } from './ledger-audit.service.js';

/** Polls for today's scheduled scan; the DB guards the daily boundary across restarts/replicas. */
export class LedgerAuditScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(LedgerAuditScheduler.name);
  private timer?: NodeJS.Timeout;
  private pending?: Promise<LedgerAuditSummary | null>;
  private stopped = true;

  constructor(
    private readonly audit: Pick<LedgerAuditService, 'run'>,
    private readonly pollMs = 60_000,
  ) {}

  tick(): Promise<LedgerAuditSummary | null> {
    this.pending ??= this.audit
      .run('SCHEDULED')
      .catch(() => {
        this.logger.warn('Scheduled credit ledger audit failed; retrying on the next poll.');
        return null;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (!this.stopped) this.schedule(this.pollMs);
      });
    }, delay);
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }
}
