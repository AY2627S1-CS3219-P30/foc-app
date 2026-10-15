import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OrdersRepository, type TransitionCommand } from './orders.repository.js';
import type { OrderAction } from './order-state-machine.js';
import type { OrderRow } from './types.js';
import { UserDirectoryClient, UserDirectoryUnavailableError } from './user-directory.client.js';

export const LIFECYCLE_SCHEDULER_OPTIONS = Symbol('LIFECYCLE_SCHEDULER_OPTIONS');

export interface LifecycleSchedulerOptions {
  pickupTimeoutMs: number;
  /** After this long in PENDING_CREDIT an order is surfaced to an operator (OS-FR1.1.3). */
  creditWaitTimeoutMs: number;
  intervalMs: number;
  batchSize?: number;
}

export interface SweepResult {
  expired: number;
  pickupTimedOut: number;
  skipped: number;
  creditWaitAlerts: number;
  adminsAssigned: number;
  adminsUnassigned: number;
  referralAlerts: number;
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
 *
 * It also keeps every dispute referred to one administrator who may act (ORD-11): an assigned
 * administrator the User Service no longer lists as active is cleared, and each unassigned dispute
 * goes to the eligible administrator with the fewest undecided disputes. Anyone who was ever the
 * errand's requester or courier is ineligible. While the User Service is down, or lists no
 * administrators at all, nothing is cleared or assigned and the next run tries again; when every
 * listed administrator took part in the errand, one REFERRAL_UNASSIGNED alert per errand and a
 * warning on every run until it is referred.
 */
@Injectable()
export class LifecycleScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LifecycleScheduler.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<SweepResult>;

  constructor(
    @Inject(OrdersRepository) private readonly orders: OrdersRepository,
    @Inject(UserDirectoryClient) private readonly directory: UserDirectoryClient,
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
      if (Object.entries(result).some(([key, count]) => key !== 'skipped' && count > 0)) {
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
    const result: SweepResult = {
      expired: 0,
      pickupTimedOut: 0,
      skipped: 0,
      creditWaitAlerts: 0,
      adminsAssigned: 0,
      adminsUnassigned: 0,
      referralAlerts: 0,
    };

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

    // Surfaced, never rejected: the reservation may still arrive and open the order.
    const waitCutoff = new Date(now.getTime() - this.options.creditWaitTimeoutMs);
    for (const alert of await this.orders.raiseCreditWaitAlerts(waitCutoff, limit)) {
      result.creditWaitAlerts += 1;
      this.logger.warn({
        orderId: alert.orderId,
        createdAt: alert.createdAt,
        waitingMs: now.getTime() - new Date(alert.createdAt).getTime(),
        alert: 'CREDIT_WAIT_EXCEEDED',
        msg: 'order still waiting for the Credit Service; operator attention needed',
      });
    }

    try {
      await this.referDisputes(now, limit, result);
    } catch (error) {
      if (!(error instanceof UserDirectoryUnavailableError)) throw error;
      this.logger.warn({
        err: error,
        msg: 'User Service unavailable; referrals wait for next run',
      });
    }
    return result;
  }

  private async referDisputes(now: Date, limit: number, result: SweepResult): Promise<void> {
    if (!(await this.orders.anyDisputed())) return;
    // One answer per run decides both who keeps a referral and who may receive one.
    const admins = await this.directory.listAdmins();
    // An empty list is trusted with nothing: clearing every referral would gain nothing, as there
    // is no one to refer to, and requests already refuse anyone who has really lost the role.
    if (admins.length === 0) {
      this.logger.warn({ msg: 'User Service lists no administrators; dispute referrals paused' });
      return;
    }

    for (const { orderId, adminId: heldBy } of await this.orders.listDisputesToRefer(
      admins,
      limit,
    )) {
      // Referred to someone who can no longer act: clear it, then refer it again below.
      if (heldBy !== null) {
        const cleared = await this.fire(
          orderId,
          'ADMIN_UNASSIGNED',
          now,
          (order) => {
            if (order.referredAdminId !== heldBy) throw new NotDue();
          },
          { referred_admin_id: null },
          heldBy,
        );
        if (!cleared) continue;
        result.adminsUnassigned += 1;
      }

      const participants = new Set(await this.orders.participants(orderId));
      const eligible = admins.filter((adminId) => !participants.has(adminId));
      if (eligible.length === 0) {
        // The alert row is kept once per errand; the warning repeats every run it stays stuck.
        const raised = await this.orders.raiseAlert(orderId, 'REFERRAL_UNASSIGNED', {
          activeAdmins: admins.length,
        });
        if (raised) result.referralAlerts += 1;
        this.logger.warn({
          orderId,
          alert: 'REFERRAL_UNASSIGNED',
          msg: 'no eligible administrator for a dispute; operator attention needed',
        });
        continue;
      }
      const adminId = await this.orders.leastReferred(eligible);
      const assigned = await this.fire(
        orderId,
        'ADMIN_ASSIGNED',
        now,
        (order) => {
          if (order.referredAdminId !== null) throw new NotDue();
        },
        { referred_admin_id: adminId },
        adminId,
      );
      if (assigned) result.adminsAssigned += 1;
    }
  }

  /** `reason`, when given, is kept on the history row (here: which administrator a referral names). */
  private async fire(
    orderId: string,
    action: OrderAction,
    now: Date,
    verify: (order: OrderRow) => void,
    patch?: TransitionCommand['patch'],
    reason?: string,
  ): Promise<boolean> {
    try {
      const outcome = await this.orders.transition({
        orderId,
        action,
        actor: { kind: 'SYSTEM', id: 'lifecycle-scheduler' },
        correlationId: `scheduler-${randomUUID()}`,
        now,
        verify,
        patch,
        reason,
      });
      return outcome.kind === 'applied';
    } catch (error) {
      if (error instanceof NotDue) return false;
      throw error;
    }
  }
}
