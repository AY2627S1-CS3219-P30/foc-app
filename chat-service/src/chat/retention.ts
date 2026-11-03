import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ChatRepository } from './chat.repository.js';
import { Upstreams, type OrderForChat } from './upstreams.js';

const DAY_MS = 24 * 60 * 60_000;

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
  ) {}

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
    this.running = this.sweep();
    try {
      const result = await this.running;
      this.logger.log({ ...result, msg: 'chat retention cleanup ran' });
      if (result.skipped > 0 && !retrying && !this.retry && this.timer) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          void this.tick(true);
        }, this.options.retryMs);
        this.retry.unref();
      }
    } catch (err) {
      this.logger.error({ err, msg: 'chat retention cleanup failed; will retry next interval' });
    } finally {
      this.running = undefined;
    }
  }

  async sweep(now = Date.now()): Promise<CleanupResult> {
    const result: CleanupResult = { deleted: 0, kept: 0, skipped: 0, unknown: 0 };
    const cutoff = new Date(now - this.options.retentionDays * DAY_MS);
    for (const orderId of await this.chat.channelsOpenedBefore(cutoff)) {
      let order: OrderForChat | undefined;
      try {
        order = await this.upstreams.order(orderId);
      } catch {
        result.skipped += 1;
        continue;
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
    if (result.skipped > 0) {
      this.logger.warn({
        skipped: result.skipped,
        msg: 'Order Service unavailable; skipped channels are asked again later',
      });
    }
    return result;
  }
}
