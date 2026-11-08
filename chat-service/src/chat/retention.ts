// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-11-03 to 2026-11-05
// Scope: Generated the initial implementation for "admin read-only access, message limits and
//   90-day retention" (NTH-03, #163, #372); later refactoring and bug fixes.
// Author review: Anselm Long and Jonus Ho validated the behaviour and the implementation, checked
//   for fatal errors, and confirmed it does not conflict with the architecture before committing.

import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ChatRepository } from './chat.repository.js';
import { Upstreams, type OrderForChat } from './upstreams.js';

const DAY_MS = 24 * 60 * 60_000;

/** How many channels a run holds in memory at once. */
const SWEEP_BATCH_SIZE = 100;
/** How many channels a run asks the Order Service about, and deletes, at once. */
const SWEEP_CONCURRENCY = 5;

/** ADR 0012 §6: true once the errand ended more than `retentionDays` ago. */
export function pastRetention(
  order: Pick<OrderForChat, 'endedAt'>,
  retentionDays: number,
  now = Date.now(),
): boolean {
  return order.endedAt !== null && now - Date.parse(order.endedAt) > retentionDays * DAY_MS;
}

export const RETENTION_OPTIONS = Symbol('RETENTION_OPTIONS');

export interface RetentionOptions {
  retentionDays: number;
  intervalMs: number;
  /** How soon a run that skipped a channel is tried once more, rather than a whole interval on. */
  retryMs: number;
  /** Whole numbers of at least 1; the constructor refuses others. */
  batchSize?: number;
  concurrency?: number;
}

export interface CleanupResult {
  deleted: number;
  /** Kept: the errand has not ended, or ended within retention. */
  kept: number;
  /** Kept, and asked again next run: the Order Service did not answer. */
  skipped: number;
  /** Kept: the Order Service knows no such errand, which should not happen, so it is logged. */
  unknown: number;
}

const noResult = (): CleanupResult => ({ deleted: 0, kept: 0, skipped: 0, unknown: 0 });

/**
 * Runs `work` on every item, on at most `limit` at once. One that fails stops nothing else. It
 * settles only when every item has been tried, so a shutdown that waits for a run waits for all of
 * it, and then throws the first failure.
 */
async function eachAtMost<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.values();
  const failures: unknown[] = [];
  const worker = async () => {
    for (const item of queue) {
      await work(item).catch((err: unknown) => failures.push(err));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
}

/**
 * Deletes each channel whose errand ended more than the retention period ago, with its messages
 * and read positions (ADR 0012 §6). Admin read records have no foreign key, so they stay.
 *
 * Only a clear answer from the Order Service deletes anything. A channel it cannot answer for is
 * skipped, and the run is tried once more after `retryMs` (5 minutes by default): on a stack
 * restart chat can be up before the Order Service, and the first run would otherwise skip every
 * channel for a day. One whose errand it does not know is kept and logged: an errand is never
 * deleted, so that is a fault to look into, not a reason to destroy dispute evidence. Every route
 * already answers 404 past retention, so a channel kept a day longer shows nothing.
 *
 * A run reads channels a page at a time and asks about a few at once, so its memory stays flat and
 * its length doesn't grow one lookup at a time with the channel count. A failed delete ends the run:
 * the page under way finishes, the run logs what it had done, and the next interval starts again.
 *
 * `main.ts` starts it once the service listens, so an app built only to test runs no sweep. It
 * runs at once, so a restart never postpones it by a whole interval, and then every interval (a
 * day by default).
 */
@Injectable()
export class RetentionCleanup implements OnApplicationShutdown {
  private readonly logger = new Logger(RetentionCleanup.name);
  private timer?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private running?: Promise<CleanupResult>;

  constructor(
    @Inject(ChatRepository) private readonly chat: ChatRepository,
    @Inject(Upstreams) private readonly upstreams: Upstreams,
    @Inject(RETENTION_OPTIONS) private readonly options: RetentionOptions,
  ) {
    for (const size of ['batchSize', 'concurrency'] as const) {
      const value = options[size];
      if (value !== undefined && !(Number.isInteger(value) && value >= 1)) {
        throw new Error(`Retention ${size} must be a whole number of at least 1.`);
      }
    }
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    clearTimeout(this.retry);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  /** `retrying`: this run is the retry, so skipping again waits for the next interval. */
  private async tick(retrying = false): Promise<void> {
    if (this.running) return;
    const result = noResult();
    this.running = this.sweep(Date.now(), result);
    try {
      await this.running;
      this.logger.log({ ...result, msg: 'chat retention cleanup ran' });
      if (result.skipped > 0 && !retrying && !this.retry && this.timer) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          void this.tick(true);
        }, this.options.retryMs);
        this.retry.unref();
      }
    } catch (err) {
      this.logger.error({
        ...result,
        err,
        msg: 'chat retention cleanup failed; will retry next interval',
      });
    } finally {
      this.running = undefined;
    }
  }

  /** `result` is filled as the run goes, so a caller still has the count if the run fails. */
  async sweep(now = Date.now(), result = noResult()): Promise<CleanupResult> {
    const cutoff = new Date(now - this.options.retentionDays * DAY_MS);
    const { batchSize = SWEEP_BATCH_SIZE, concurrency = SWEEP_CONCURRENCY } = this.options;
    let after: string | undefined;
    for (;;) {
      const page = await this.chat.channelsOpenedBefore(cutoff, batchSize, after);
      await eachAtMost(page, concurrency, (orderId) => this.settle(orderId, result, now));
      if (page.length < batchSize) break;
      after = page[page.length - 1];
    }
    if (result.skipped > 0) {
      this.logger.warn({
        skipped: result.skipped,
        msg: 'Order Service unavailable; skipped channels are asked again later',
      });
    }
    return result;
  }

  /** Asks about one channel and acts on the answer, counting the outcome in `result`. */
  private async settle(orderId: string, result: CleanupResult, now: number): Promise<void> {
    let order: OrderForChat | undefined;
    try {
      order = await this.upstreams.order(orderId);
    } catch {
      result.skipped += 1;
      return;
    }
    if (!order) {
      result.unknown += 1;
      this.logger.warn({ orderId, msg: 'Order Service knows no errand for this channel; kept' });
    } else if (pastRetention(order, this.options.retentionDays, now)) {
      await this.chat.deleteChannel(orderId);
      result.deleted += 1;
    } else {
      result.kept += 1;
    }
  }
}
