import type { OrderStatus } from './types.js';

export const ORDER_ACTIONS = [
  'CREDIT_RESERVED',
  'CREDIT_REJECTED',
  'ACCEPT',
  'CANCEL',
  'REQUESTER_SUSPENDED',
  'ACCEPTANCE_DEADLINE_PASSED',
  'RECORD_PICKUP',
  'WITHDRAW',
  'PICKUP_TIMEOUT',
  'COURIER_SUSPENDED',
  'RECORD_DELIVERY',
  'REPORT_NON_DELIVERY',
  'DELIVERY_PERIOD_PASSED',
  'CONFIRM_RECEIPT',
  'AUTO_CONFIRM',
  'REPORT_NON_RECEIPT',
  'RESOLVE_FOR_COURIER',
  'RESOLVE_FOR_REQUESTER',
  'TRANSFER_CONFIRMED',
  'RELEASE_CONFIRMED',
] as const;

export type OrderAction = (typeof ORDER_ACTIONS)[number];

export const ORDER_ACTORS = [
  'REQUESTER',
  'ASSIGNED_COURIER',
  'OTHER_STUDENT',
  'ADMIN',
  'CREDIT_SERVICE',
  'SYSTEM',
] as const;

export type OrderActor = (typeof ORDER_ACTORS)[number];

export interface TransitionContext {
  acceptanceDeadlinePassed?: boolean;
  deliveryPeriodPassed?: boolean;
  requesterSuspended?: boolean;
  reasonProvided?: boolean;
  releaseReason?: 'CANCELLED' | 'EXPIRED';
}

export interface TransitionDecision {
  to: OrderStatus;
  releaseReason?: 'CANCELLED' | 'EXPIRED';
  emitted: readonly string[];
}

interface TransitionRule {
  from: OrderStatus;
  action: OrderAction;
  actors: readonly OrderActor[];
  guard?: (context: TransitionContext) => boolean;
  decide: (context: TransitionContext) => TransitionDecision;
}

const statusChanged = ['order.status-changed'] as const;
const completion = ['order.completion-requested', 'order.status-changed'] as const;
const release = ['order.release-requested', 'order.status-changed'] as const;

/**
 * Executable counterpart of the README transition table. Runtime commands and
 * the generated authorization matrix use this same definition so they cannot
 * silently drift apart.
 */
export const ORDER_TRANSITIONS: readonly TransitionRule[] = [
  {
    from: 'PENDING_CREDIT',
    action: 'CREDIT_RESERVED',
    actors: ['CREDIT_SERVICE'],
    guard: (c) => !c.requesterSuspended,
    decide: () => ({ to: 'OPEN', emitted: statusChanged }),
  },
  {
    from: 'PENDING_CREDIT',
    action: 'CREDIT_RESERVED',
    actors: ['CREDIT_SERVICE'],
    guard: (c) => c.requesterSuspended === true,
    decide: () => ({ to: 'RELEASE_PENDING_CREDIT', releaseReason: 'CANCELLED', emitted: release }),
  },
  {
    from: 'PENDING_CREDIT',
    action: 'CREDIT_REJECTED',
    actors: ['CREDIT_SERVICE'],
    decide: () => ({ to: 'REJECTED', emitted: statusChanged }),
  },
  {
    from: 'OPEN',
    action: 'ACCEPT',
    actors: ['OTHER_STUDENT'],
    guard: (c) => !c.acceptanceDeadlinePassed,
    decide: () => ({ to: 'ACCEPTED', emitted: statusChanged }),
  },
  {
    from: 'OPEN',
    action: 'CANCEL',
    actors: ['REQUESTER'],
    decide: () => ({ to: 'RELEASE_PENDING_CREDIT', releaseReason: 'CANCELLED', emitted: release }),
  },
  {
    from: 'OPEN',
    action: 'REQUESTER_SUSPENDED',
    actors: ['SYSTEM'],
    decide: () => ({ to: 'RELEASE_PENDING_CREDIT', releaseReason: 'CANCELLED', emitted: release }),
  },
  {
    from: 'OPEN',
    action: 'ACCEPTANCE_DEADLINE_PASSED',
    actors: ['SYSTEM'],
    decide: () => ({ to: 'RELEASE_PENDING_CREDIT', releaseReason: 'EXPIRED', emitted: release }),
  },
  {
    from: 'ACCEPTED',
    action: 'RECORD_PICKUP',
    actors: ['ASSIGNED_COURIER'],
    decide: () => ({ to: 'PICKED_UP', emitted: statusChanged }),
  },
  {
    from: 'ACCEPTED',
    action: 'CANCEL',
    actors: ['REQUESTER'],
    decide: () => ({ to: 'RELEASE_PENDING_CREDIT', releaseReason: 'CANCELLED', emitted: release }),
  },
  {
    from: 'ACCEPTED',
    action: 'REQUESTER_SUSPENDED',
    actors: ['SYSTEM'],
    decide: () => ({ to: 'RELEASE_PENDING_CREDIT', releaseReason: 'CANCELLED', emitted: release }),
  },
  {
    from: 'ACCEPTED',
    action: 'WITHDRAW',
    actors: ['ASSIGNED_COURIER'],
    guard: (c) => !c.acceptanceDeadlinePassed,
    decide: () => ({ to: 'OPEN', emitted: statusChanged }),
  },
  {
    from: 'ACCEPTED',
    action: 'WITHDRAW',
    actors: ['ASSIGNED_COURIER'],
    guard: (c) => c.acceptanceDeadlinePassed === true,
    decide: () => ({ to: 'RELEASE_PENDING_CREDIT', releaseReason: 'EXPIRED', emitted: release }),
  },
  {
    from: 'ACCEPTED',
    action: 'PICKUP_TIMEOUT',
    actors: ['SYSTEM'],
    guard: (c) => !c.acceptanceDeadlinePassed,
    decide: () => ({ to: 'OPEN', emitted: statusChanged }),
  },
  {
    from: 'ACCEPTED',
    action: 'PICKUP_TIMEOUT',
    actors: ['SYSTEM'],
    guard: (c) => c.acceptanceDeadlinePassed === true,
    decide: () => ({ to: 'RELEASE_PENDING_CREDIT', releaseReason: 'EXPIRED', emitted: release }),
  },
  {
    from: 'ACCEPTED',
    action: 'COURIER_SUSPENDED',
    actors: ['SYSTEM'],
    decide: () => ({ to: 'OPEN', emitted: statusChanged }),
  },
  {
    from: 'PICKED_UP',
    action: 'RECORD_DELIVERY',
    actors: ['ASSIGNED_COURIER'],
    decide: () => ({ to: 'DELIVERED', emitted: statusChanged }),
  },
  {
    from: 'PICKED_UP',
    action: 'REPORT_NON_DELIVERY',
    actors: ['REQUESTER'],
    guard: (c) => c.deliveryPeriodPassed === true,
    decide: () => ({ to: 'DISPUTED', emitted: statusChanged }),
  },
  {
    from: 'PICKED_UP',
    action: 'DELIVERY_PERIOD_PASSED',
    actors: ['SYSTEM'],
    guard: (c) => c.requesterSuspended === true,
    decide: () => ({ to: 'DISPUTED', emitted: statusChanged }),
  },
  {
    from: 'PICKED_UP',
    action: 'COURIER_SUSPENDED',
    actors: ['SYSTEM'],
    decide: () => ({ to: 'DISPUTED', emitted: statusChanged }),
  },
  {
    from: 'DELIVERED',
    action: 'CONFIRM_RECEIPT',
    actors: ['REQUESTER'],
    decide: () => ({ to: 'COMPLETION_PENDING_CREDIT', emitted: completion }),
  },
  {
    from: 'DELIVERED',
    action: 'AUTO_CONFIRM',
    actors: ['SYSTEM'],
    decide: () => ({ to: 'COMPLETION_PENDING_CREDIT', emitted: completion }),
  },
  {
    from: 'DELIVERED',
    action: 'REPORT_NON_RECEIPT',
    actors: ['REQUESTER'],
    decide: () => ({ to: 'DISPUTED', emitted: statusChanged }),
  },
  {
    from: 'DISPUTED',
    action: 'RESOLVE_FOR_COURIER',
    actors: ['ADMIN'],
    guard: (c) => c.reasonProvided === true,
    decide: () => ({ to: 'COMPLETION_PENDING_CREDIT', emitted: completion }),
  },
  {
    from: 'DISPUTED',
    action: 'RESOLVE_FOR_REQUESTER',
    actors: ['ADMIN'],
    guard: (c) => c.reasonProvided === true,
    decide: () => ({ to: 'RELEASE_PENDING_CREDIT', releaseReason: 'CANCELLED', emitted: release }),
  },
  {
    from: 'COMPLETION_PENDING_CREDIT',
    action: 'TRANSFER_CONFIRMED',
    actors: ['CREDIT_SERVICE'],
    decide: () => ({ to: 'COMPLETED', emitted: statusChanged }),
  },
  {
    from: 'RELEASE_PENDING_CREDIT',
    action: 'RELEASE_CONFIRMED',
    actors: ['CREDIT_SERVICE'],
    guard: (c) => c.releaseReason === 'CANCELLED',
    decide: () => ({ to: 'CANCELLED', emitted: statusChanged }),
  },
  {
    from: 'RELEASE_PENDING_CREDIT',
    action: 'RELEASE_CONFIRMED',
    actors: ['CREDIT_SERVICE'],
    guard: (c) => c.releaseReason === 'EXPIRED',
    decide: () => ({ to: 'EXPIRED', emitted: statusChanged }),
  },
];

export function decideTransition(
  from: OrderStatus,
  action: OrderAction,
  actor: OrderActor,
  context: TransitionContext = {},
): TransitionDecision | null {
  const rule = ORDER_TRANSITIONS.find(
    (candidate) =>
      candidate.from === from &&
      candidate.action === action &&
      candidate.actors.includes(actor) &&
      (!candidate.guard || candidate.guard(context)),
  );
  return rule?.decide(context) ?? null;
}
