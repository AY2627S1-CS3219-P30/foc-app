import { randomUUID } from 'node:crypto';
import { LifecycleScheduler } from '../../order-service/src/orders/lifecycle.scheduler.js';
import type { OrderAction } from '../../order-service/src/orders/order-state-machine.js';
import { agreementViolations, economyViolations } from './invariants.js';
import { createOrder } from './scenario.js';
import type { Stack } from './stack.js';

/** mulberry32: a small, fast, seedable PRNG so every run can be replayed from its seed. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
  };
}

export interface SimulationOptions {
  seed: number;
  users: number;
  steps: number;
  /** Probability that any one delivery is dropped, and that it is duplicated. */
  dropRate: number;
  duplicateRate: number;
}

export interface SimulationResult {
  seed: number;
  steps: number;
  orders: number;
  operations: Record<string, number>;
  refused: number;
  deliveries: { handled: number; dropped: number; deadLettered: number; duplicated: number };
  repairs: number;
  finalStatuses: Record<string, number>;
  violations: string[];
}

const ACTIONS: OrderAction[] = [
  'ACCEPT',
  'RECORD_PICKUP',
  'RECORD_DELIVERY',
  'CONFIRM_RECEIPT',
  'CANCEL',
  'WITHDRAW',
];

/**
 * A randomised order economy: users create errands with random rewards, other users accept,
 * fulfil, cancel, withdraw and let deadlines lapse, any user may attempt any action (most are
 * refused), and the bus randomly drops and duplicates messages. The economy invariants are
 * checked after every step; at the end faults stop, reconciliation runs to quiescence, and the
 * two services must agree on every order.
 */
export async function simulate(
  stack: Stack,
  options: SimulationOptions,
): Promise<SimulationResult> {
  const random = prng(options.seed);
  const users = Array.from({ length: options.users }, (_, i) => `sim-user-${options.seed}-${i}`);
  for (const user of users) await stack.issueWallet(user);
  const scheduler = new LifecycleScheduler(stack.orders, {
    pickupTimeoutMs: 30 * 60_000,
    creditWaitTimeoutMs: 5 * 60_000,
    intervalMs: 60_000,
  });
  const reconcile = stack.reconciler({ staleAfterMs: 0, retryAfterMs: 0 });

  const result: SimulationResult = {
    seed: options.seed,
    steps: options.steps,
    orders: 0,
    operations: {},
    refused: 0,
    deliveries: { handled: 0, dropped: 0, deadLettered: 0, duplicated: 0 },
    repairs: 0,
    finalStatuses: {},
    violations: [],
  };
  const count = (op: string) => (result.operations[op] = (result.operations[op] ?? 0) + 1);
  stack.bus.fault = () => {
    if (random.chance(options.dropRate)) return 'drop';
    if (random.chance(options.duplicateRate)) {
      result.deliveries.duplicated += 1;
      return 'duplicate';
    }
    return 'deliver';
  };

  const orderIds: string[] = [];
  for (let step = 0; step < options.steps; step++) {
    const roll = random.next();
    if (roll < 0.25 || orderIds.length === 0) {
      orderIds.push(await createOrder(stack, random.pick(users), random.int(1, 5)));
      count('create');
    } else if (roll < 0.85) {
      const orderId = random.pick(orderIds);
      const order = (await stack.orders.findById(orderId))!;
      // Mostly move orders along their normal path by the right actor; otherwise anyone tries
      // anything, which the transition table must refuse without a trace.
      const forward = NEXT[order.status];
      const progress = forward !== undefined && random.chance(0.6);
      const action = progress ? forward : random.pick(ACTIONS);
      let actor = random.pick(users);
      if (progress) {
        if (action === 'ACCEPT') actor = random.pick(users.filter((u) => u !== order.requesterId));
        else actor = participant(order, action) ?? actor;
      }
      const outcome =
        action === 'ACCEPT'
          ? (await stack.orders.accept(orderId, actor, order.version, `sim-${randomUUID()}`))
              .accepted
          : (
              await stack.orders.transition({
                orderId,
                action,
                actor: { kind: 'USER', id: actor, isAdmin: false },
                correlationId: `sim-${randomUUID()}`,
              })
            ).kind === 'applied';
      count(action);
      if (!outcome) result.refused += 1;
    } else if (roll < 0.92) {
      // Let a random open errand's deadline lapse, and the scheduler expire it.
      const orderId = random.pick(orderIds);
      await stack.orderDb.db.query(
        `UPDATE orders SET acceptance_deadline_at = now() - interval '1 second'
          WHERE order_id = $1 AND status IN ('OPEN', 'ACCEPTED')`,
        [orderId],
      );
      await scheduler.sweep();
      count('expire');
    } else {
      result.repairs += (await reconcile.run()).reissued;
      count('reconcile');
    }

    await stack.settle();
    const violations = await economyViolations(stack);
    violations.push(...(await agreementViolations(stack, false)));
    if (violations.length > 0) {
      result.violations.push(...violations.map((v) => `step ${step}: ${v}`));
      break;
    }
  }

  // Quiescence: no more faults; repair until nothing is left waiting on Credit.
  stack.bus.fault = () => 'deliver';
  for (let round = 0; round < 10; round++) {
    await stack.settle();
    const run = await reconcile.run();
    result.repairs += run.reissued;
    await stack.settle();
    if (run.candidates === 0) break;
  }
  result.violations.push(...(await economyViolations(stack)));
  result.violations.push(...(await agreementViolations(stack, true)));

  result.orders = orderIds.length;
  for (const delivery of stack.bus.deliveries) {
    if (delivery.outcome === 'handled') result.deliveries.handled += 1;
    else if (delivery.outcome === 'dropped') result.deliveries.dropped += 1;
    else result.deliveries.deadLettered += 1;
  }
  const statuses = await stack.orderDb.db.query<{ status: string; n: string }>(
    `SELECT status, count(*) AS n FROM orders WHERE order_id = ANY($1) GROUP BY status`,
    [orderIds],
  );
  for (const row of statuses.rows) result.finalStatuses[row.status] = Number(row.n);
  return result;
}

const NEXT: Partial<Record<string, OrderAction>> = {
  OPEN: 'ACCEPT',
  ACCEPTED: 'RECORD_PICKUP',
  PICKED_UP: 'RECORD_DELIVERY',
  DELIVERED: 'CONFIRM_RECEIPT',
};

/** The participant who would legitimately perform this action, to keep the economy moving. */
function participant(
  order: { requesterId: string; courierId: string | null },
  action: OrderAction,
): string | null {
  if (action === 'CONFIRM_RECEIPT' || action === 'CANCEL') return order.requesterId;
  return order.courierId;
}
