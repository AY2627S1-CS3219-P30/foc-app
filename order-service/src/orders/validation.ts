import { ApiException } from '@foc/platform';
import { z } from 'zod';
import { decodeCursor } from './cursor.js';
import { ORDER_STATUSES } from './types.js';

const item = z
  .object({
    name: z.string().trim().min(1).max(200),
    quantity: z.number().int().min(1).max(100),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const createOrderSchema = z
  .object({
    supplierId: z.uuid(),
    items: z.array(item).min(1).max(50),
    deliveryZone: z.string().trim().min(1).max(200),
    deliveryInstructions: z.string().trim().min(1).max(1000),
    reward: z.number().int().min(1).max(5),
  })
  .strict();

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

const acceptOrderSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export function parseCreateOrder(value: unknown): CreateOrderInput {
  const result = createOrderSchema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiException(
    422,
    'VALIDATION_FAILED',
    'The order request is invalid.',
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      code: issue.code,
      message: issue.message,
    })),
  );
}

export function parseAcceptOrder(value: unknown): { expectedVersion: number } {
  const result = acceptOrderSchema.safeParse(value);
  if (!result.success) {
    throw new ApiException(
      422,
      'VALIDATION_FAILED',
      'The acceptance request is invalid.',
      result.error.issues,
    );
  }
  return result.data;
}

const resolveOrderSchema = z
  .object({
    outcome: z.enum(['COURIER', 'REQUESTER']),
    reason: z.string().trim().min(1).max(500),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export type ResolveOrderInput = z.infer<typeof resolveOrderSchema>;

export function parseResolveOrder(value: unknown): ResolveOrderInput {
  const result = resolveOrderSchema.safeParse(value);
  if (!result.success) {
    throw new ApiException(
      422,
      'VALIDATION_FAILED',
      'The decision is invalid.',
      result.error.issues,
    );
  }
  return result.data;
}

const orderIdSchema = z.uuid();

export function parseOrderId(id: string): string {
  const parsed = orderIdSchema.safeParse(id);
  if (!parsed.success) throw new ApiException(400, 'INVALID_ORDER_ID', 'Order ID must be a UUID.');
  return parsed.data;
}

const exactTime = z.iso.datetime();

/** Where a page of open errands ended, in their order: deadline, then posting time, then ID. */
const openCursorSchema = z
  .object({ deadline: exactTime, createdAt: exactTime, orderId: z.uuid() })
  .strict();

/** Where a page of the caller's errands ended, in their order: last change, then ID. */
const mineCursorSchema = z.object({ updatedAt: exactTime, orderId: z.uuid() }).strict();

export type OpenCursor = z.infer<typeof openCursorSchema>;
export type MineCursor = z.infer<typeof mineCursorSchema>;

const page = {
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
};

const myOrdersQuerySchema = z
  .object({
    role: z.enum(['REQUESTER', 'COURIER']).optional(),
    active: z.enum(['true', 'false']).optional(),
    ...page,
  })
  .strict();

export type MyOrdersQuery = {
  role?: 'REQUESTER' | 'COURIER';
  active?: boolean;
  limit: number;
  after?: MineCursor;
};

export function parseMyOrdersQuery(value: unknown): MyOrdersQuery {
  const result = myOrdersQuerySchema.safeParse(value);
  if (!result.success) {
    throw new ApiException(
      422,
      'VALIDATION_FAILED',
      'The orders query is invalid.',
      result.error.issues,
    );
  }
  const { role, active, limit, cursor } = result.data;
  return {
    role,
    active: active === undefined ? undefined : active === 'true',
    limit,
    after: decodeCursor(mineCursorSchema, cursor),
  };
}

/** Not strict: `GET /orders` has always ignored parameters it does not know. */
const openOrdersQuerySchema = z.object({
  pickupBuilding: z.string().trim().min(1).max(200).optional(),
  minReward: z.coerce.number().int().min(1).optional(),
  ...page,
});

export type OpenOrdersQuery = {
  pickupBuilding?: string;
  minReward?: number;
  limit: number;
  after?: OpenCursor;
};

export function parseOpenOrdersQuery(value: unknown): OpenOrdersQuery {
  const result = openOrdersQuerySchema.safeParse(value);
  if (!result.success) {
    throw new ApiException(
      422,
      'VALIDATION_FAILED',
      'The open errands query is invalid.',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'query',
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  const { cursor, ...query } = result.data;
  return { ...query, after: decodeCursor(openCursorSchema, cursor) };
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (!value) {
    throw new ApiException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
  }
  if (value.length > 200 || value.trim().length === 0) {
    throw new ApiException(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must contain 1 to 200 characters.',
    );
  }
  return value;
}

/** `status=OPEN,ACCEPTED`: one or more statuses, comma-separated, each one the API knows. */
const statusListSchema = z
  // A repeated `status` arrives as an array; say how to send several instead.
  .string({
    error: 'Give the statuses in one status parameter, comma-separated: status=OPEN,ACCEPTED.',
  })
  .max(400)
  .transform((value) => value.split(','))
  .pipe(z.array(z.enum(ORDER_STATUSES)).min(1))
  .transform((statuses) => [...new Set(statuses)]);

/**
 * An administrator's errand list: one account's (ORD-15) when `requesterId` or `courierId` is
 * given, every errand otherwise (ADM-06), narrowed to `status` when given. `before` names the last
 * errand a previous page showed, and lists only those after it.
 */
const adminOrdersSchema = z
  .object({
    requesterId: z.string().trim().min(1).max(200).optional(),
    courierId: z.string().trim().min(1).max(200).optional(),
    status: statusListSchema.optional(),
    before: z.uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type AdminOrdersQuery = z.infer<typeof adminOrdersSchema>;

export function parseAdminOrdersQuery(value: unknown): AdminOrdersQuery {
  const result = adminOrdersSchema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiException(
    422,
    'VALIDATION_FAILED',
    'The errand query is invalid.',
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'query',
      code: issue.code,
      message: issue.message,
    })),
  );
}
