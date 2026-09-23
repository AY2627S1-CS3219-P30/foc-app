import { z } from 'zod';

/**
 * The messages the platform exchanges, one per workflow named in EI-FR1.1.1.
 *
 * Names are an implementation choice — the backlog describes workflows, not
 * event names. Adding one means adding it here and binding a queue to it in
 * the owning service; nothing is discovered at runtime.
 */
export const EVENTS = {
  /** Workflow 1 — create a wallet after a student's first activation. */
  USER_ACTIVATED: 'user.activated',
  /** Workflow 2 — share suspensions and reactivations. */
  USER_SUSPENDED: 'user.suspended',
  USER_REACTIVATED: 'user.reactivated',
  /** Workflow 3 — transfer credits after an errand completes. */
  ORDER_COMPLETION_REQUESTED: 'order.completion-requested',
  CREDITS_TRANSFERRED: 'credit.transferred',
  /** Workflow 4 — return credits after a cancellation or expiry. */
  CREDIT_RELEASE_REQUESTED: 'credit.release-requested',
  CREDITS_RELEASED: 'credit.released',
  /** Workflow 5 — share each errand status change. */
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

/**
 * Payload schemas for the workflows Sprint 2 implements. Declared now so the
 * topology is complete and a producer cannot invent a shape later without
 * changing this file, where a reviewer will see it.
 */
export const PAYLOAD_SCHEMAS = {
  [EVENTS.USER_ACTIVATED]: userActivatedPayload,
  [EVENTS.USER_SUSPENDED]: userStatusChangedPayload,
  [EVENTS.USER_REACTIVATED]: userStatusChangedPayload,
} as const satisfies Partial<Record<EventType, z.ZodType>>;
