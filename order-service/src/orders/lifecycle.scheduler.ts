import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OrdersRepository } from './orders.repository.js';
import type { OrderAction } from './order-state-machine.js';
import type { OrderRow } from './types.js';

export const LIFECYCLE_SCHEDULER_OPTIONS = Symbol('LIFECYCLE_SCHEDULER_OPTIONS');

export interface LifecycleSchedulerOptions {
  pickupTimeoutMs: number;
  intervalMs: number;
  batchSize?: number;
}

export interface SweepResult {
  expired: number;
  pickupTimedOut: number;
  skipped: number;
}

/** Thrown inside a transition to skip an order whose timer is no longer due once locked. */
class NotDue extends Error {}

/**
 * Owns every time-based Order rule (ORD-05): an OPEN order past its acceptance deadline expires,
 * and an ACCEPTED order with no pickup within the pickup timeout loses its courier. It runs once
 * as soon as the service is ready — so timers that fell due during downtime fire within one
 * interval of restart — and then every interval (at most 60 s, OS-NFR3.1.1).
 *
 * Each timer fires through the ordinary transition path: the row is locked, the timer is checked
 * again against the database clock, and the state table decides. An order that a participant
 * changed in the meantime, or that a second instance already handled, is simply skipped, so every
 * timer takes effect exactly once and accept-versus-expire is decided by the row's version.
 */
@Injectable()
export class LifecycleScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LifecycleScheduler.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<SweepResult>;

  constructor(
    @Inject(OrdersRepository) private readonly orders: OrdersRepository,
    @Inject(LIFECYCLE_SCHEDULER_OPTIONS) private readonly options: LifecycleSchedulerOptions,
  ) {}

  onApplicationBootstrap(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // never overlap two sweeps in one process
    this.running = this.sweep();
    try {
      const result = await this.running;
      if (result.expired + result.pickupTimedOut > 0) {
        this.logger.log({ ...result, msg: 'lifecycle timers applied' });
      }
    } catch (err) {
      this.logger.error({ err, msg: 'lifecycle sweep failed; will retry next interval' });
    } finally {
      this.running = undefined;
    }
  }

  async sweep(): Promise<SweepResult> {
    const now = await this.orders.databaseNow();
    const limit = this.options.batchSize ?? 100;
    const result: SweepResult = { expired: 0, pickupTimedOut: 0, skipped: 0 };

    for (const orderId of await this.orders.findOverdueOpen(now, limit)) {
      const applied = await this.fire(orderId, 'ACCEPTANCE_DEADLINE_PASSED', now, (order) => {
        if (!order.acceptanceDeadlineAt || new Date(order.acceptanceDeadlineAt) > now) {
          throw new NotDue();
        }
      });
      result[applied ? 'expired' : 'skipped'] += 1;
    }

    const cutoff = new Date(now.getTime() - this.options.pickupTimeoutMs);
    for (const orderId of await this.orders.findPickupOverdue(cutoff, limit)) {
      const applied = await this.fire(orderId, 'PICKUP_TIMEOUT', now, (order) => {
        // A courier who accepted again after a withdrawal starts a new pickup timer.
        if (!order.acceptedAt || new Date(order.acceptedAt) > cutoff) throw new NotDue();
      });
      result[applied ? 'pickupTimedOut' : 'skipped'] += 1;
    }
    return result;
  }

  private async fire(
    orderId: string,
    action: OrderAction,
    now: Date,
    verify: (order: OrderRow) => void,
  ): Promise<boolean> {
    try {
      const outcome = await this.orders.transition({
        orderId,
        action,
        actor: { kind: 'SYSTEM', id: 'lifecycle-scheduler' },
        correlationId: `scheduler-${randomUUID()}`,
        now,
        verify,
      });
      return outcome.kind === 'applied';
    } catch (error) {
      if (error instanceof NotDue) return false;
      throw error;
    }
  }
}
