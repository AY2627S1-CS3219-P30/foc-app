import { z } from 'zod';

/**
 * The messages the platform exchanges, grouped by the workflow in EI-FR1.1.1
 * that each one serves.
 *
 * Names are an implementation choice — the backlog describes workflows, not
 * event names. Adding one means adding it here and binding a queue to it in
 * the owning service; nothing is discovered at runtime.
 *
 * A routing key is prefixed by the service that publishes it, never the one
 * that consumes it, so the Order Service's request to the Credit Service is
 * `order.reservation-requested`. Each service then publishes under a single
 * prefix: the sender is readable from the key alone, and per-service broker
 * users could later be restricted to their own prefix.
 */
export const EVENTS = {
  /** Workflow 1 — create a wallet after a student's first activation. */
  USER_ACTIVATED: 'user.activated',
  /** Workflow 2 — share suspensions and reactivations. */
  USER_SUSPENDED: 'user.suspended',
  USER_REACTIVATED: 'user.reactivated',
  /**
   * An administrator role granted or revoked (USR-07), so a service that caches
   * a caller's roles drops them at once rather than when its cache expires.
   */
  USER_ROLE_CHANGED: 'user.role-changed',
  /**
   * Workflow 3 — reserve an errand's reward before couriers can see it. The
   * errand is saved first and stays hidden until one of the two replies
   * arrives, so creating one never depends on the Credit Service being up.
   */
  CREDIT_RESERVATION_REQUESTED: 'order.reservation-requested',
  CREDITS_RESERVED: 'credit.reserved',
  CREDIT_RESERVATION_REJECTED: 'credit.reservation-rejected',
  /** Workflow 4 — transfer credits after an errand completes. */
  ORDER_COMPLETION_REQUESTED: 'order.completion-requested',
  CREDITS_TRANSFERRED: 'credit.transferred',
  /** Workflow 5 — return credits after a cancellation or expiry. */
  CREDIT_RELEASE_REQUESTED: 'order.release-requested',
  CREDITS_RELEASED: 'credit.released',
  /** Workflow 6 — share each errand status change. */
  ORDER_STATUS_CHANGED: 'order.status-changed',
} as const;

export type EventType = (typeof EVENTS)[keyof typeof EVENTS];

export const userActivatedPayload = z.object({
  userId: z.string().min(1),
  activatedAt: z.iso.datetime(),
});
export type UserActivatedPayload = z.infer<typeof userActivatedPayload>;

export const userStatusChangedPayload = z.object({
  userId: z.string().min(1),
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  reasonRef: z.string().optional(),
  occurredAt: z.iso.datetime(),
});
export type UserStatusChangedPayload = z.infer<typeof userStatusChangedPayload>;

/** The user's roles after the change. `reasonRef` is the audit record's id. */
export const userRoleChangedPayload = z.object({
  userId: z.string().min(1),
  roles: z.array(z.enum(['STUDENT', 'ADMIN'])),
  reasonRef: z.string().optional(),
  occurredAt: z.iso.datetime(),
});
export type UserRoleChangedPayload = z.infer<typeof userRoleChangedPayload>;

/**
 * One reservation: which errand, whose credits, how many. The request carries
 * it and both replies restate it, so the Order Service can check that an answer
 * is for the errand, requester and amount it asked about before acting on it.
 *
 * `amount` is checked for whole, positive credits and nothing more. The
 * one-to-five reward range is policy, which the Credit Service enforces with a
 * rejection so the requester hears why. A message that fails its schema is set
 * aside with no reply at all, and the errand would be left waiting.
 */
const reservation = {
  orderId: z.string().min(1),
  requesterId: z.string().min(1),
  amount: z.number().int().positive(),
};

export const creditReservationRequestedPayload = z.object(reservation);
export type CreditReservationRequestedPayload = z.infer<typeof creditReservationRequestedPayload>;

export const creditsReservedPayload = z.object(reservation);
export type CreditsReservedPayload = z.infer<typeof creditsReservedPayload>;

/**
 * Why a reservation was refused. Insufficient credits carries the balance that
 * was available, so the requester can be told how far short they are
 * (OS-FR1.1.1).
 *
 * A missing wallet is deliberately not a reason: the activation that creates it
 * may simply not have been processed yet, so the Credit Service retries rather
 * than refuses (EI-NFR2.1.2).
 */
export const creditReservationRejectedPayload = z.discriminatedUnion('reason', [
  z.object({
    ...reservation,
    reason: z.literal('INSUFFICIENT_CREDITS'),
    available: z.number().int().nonnegative(),
  }),
  z.object({ ...reservation, reason: z.literal('AMOUNT_OUT_OF_RANGE') }),
  z.object({ ...reservation, reason: z.literal('CONFLICTING_REQUEST') }),
]);
export type CreditReservationRejectedPayload = z.infer<typeof creditReservationRejectedPayload>;

/**
 * Terminal credit movements always identify the reservation they settle. The
 * requester and amount are restated so Credit can compare them with the
 * recorded reservation before moving anything. A completion also names the
 * courier whose wallet earns the reward; that identity is authoritative only
 * because the message is accepted exclusively from Order Service.
 */
const terminalMovement = {
  orderId: z.string().min(1),
  requesterId: z.string().min(1),
  amount: z.number().int().positive(),
};

export const orderCompletionRequestedPayload = z.object({
  ...terminalMovement,
  courierId: z.string().min(1),
});
export type OrderCompletionRequestedPayload = z.infer<typeof orderCompletionRequestedPayload>;

const resultingBalance = z
  .object({
    available: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .refine((balance) => balance.total === balance.available + balance.reserved, {
    message: 'total must equal available plus reserved',
  });

export const creditsTransferredPayload = z.object({
  ...terminalMovement,
  courierId: z.string().min(1),
  transactionId: z.uuid(),
  requesterBalance: resultingBalance,
  courierBalance: resultingBalance,
});
export type CreditsTransferredPayload = z.infer<typeof creditsTransferredPayload>;

export const creditReleaseRequestedPayload = z.object(terminalMovement);
export type CreditReleaseRequestedPayload = z.infer<typeof creditReleaseRequestedPayload>;

export const creditsReleasedPayload = z.object({
  ...terminalMovement,
  transactionId: z.uuid(),
  requesterBalance: resultingBalance,
});
export type CreditsReleasedPayload = z.infer<typeof creditsReleasedPayload>;

export const orderStatus = z.enum([
  'PENDING_CREDIT',
  'OPEN',
  'ACCEPTED',
  'PICKED_UP',
  'DELIVERED',
  'DISPUTED',
  'COMPLETION_PENDING_CREDIT',
  'RELEASE_PENDING_CREDIT',
  'REJECTED',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
]);

/** Public lifecycle fact. It deliberately carries no participant or delivery details. */
export const orderStatusChangedPayload = z
  .object({
    orderId: z.uuid(),
    previousStatus: orderStatus.nullable(),
    newStatus: orderStatus,
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type OrderStatusChangedPayload = z.infer<typeof orderStatusChangedPayload>;

/**
 * Payload schemas, keyed by event type. An event missing from here has no
 * agreed shape yet — the ticket that first publishes it adds one — so a
 * producer cannot invent a shape without changing this file, where a reviewer
 * will see it.
 */
export const PAYLOAD_SCHEMAS = {
  [EVENTS.USER_ACTIVATED]: userActivatedPayload,
  [EVENTS.USER_SUSPENDED]: userStatusChangedPayload,
  [EVENTS.USER_REACTIVATED]: userStatusChangedPayload,
  [EVENTS.USER_ROLE_CHANGED]: userRoleChangedPayload,
  [EVENTS.CREDIT_RESERVATION_REQUESTED]: creditReservationRequestedPayload,
  [EVENTS.CREDITS_RESERVED]: creditsReservedPayload,
  [EVENTS.CREDIT_RESERVATION_REJECTED]: creditReservationRejectedPayload,
  [EVENTS.ORDER_COMPLETION_REQUESTED]: orderCompletionRequestedPayload,
  [EVENTS.CREDITS_TRANSFERRED]: creditsTransferredPayload,
  [EVENTS.CREDIT_RELEASE_REQUESTED]: creditReleaseRequestedPayload,
  [EVENTS.CREDITS_RELEASED]: creditsReleasedPayload,
  [EVENTS.ORDER_STATUS_CHANGED]: orderStatusChangedPayload,
} as const satisfies Partial<Record<EventType, z.ZodType>>;
