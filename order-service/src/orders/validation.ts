import { ApiException } from '@foc/platform';
import { z } from 'zod';

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

const myOrdersQuerySchema = z
  .object({
    role: z.enum(['REQUESTER', 'COURIER']).optional(),
    active: z.enum(['true', 'false']).optional(),
  })
  .strict();

export type MyOrdersQuery = { role?: 'REQUESTER' | 'COURIER'; active?: boolean };

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
  return {
    role: result.data.role,
    active: result.data.active === undefined ? undefined : result.data.active === 'true',
  };
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

const accountErrandsSchema = z
  .object({
    requesterId: z.string().trim().min(1).max(200).optional(),
    courierId: z.string().trim().min(1).max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine((query) => query.requesterId !== undefined || query.courierId !== undefined, {
    message: 'Give requesterId, courierId or both.',
    path: ['requesterId'],
  });

export type AccountErrandsQuery = z.infer<typeof accountErrandsSchema>;

export function parseAccountErrandsQuery(value: unknown): AccountErrandsQuery {
  const result = accountErrandsSchema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiException(
    422,
    'VALIDATION_FAILED',
    'The account query is invalid.',
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'query',
      code: issue.code,
      message: issue.message,
    })),
  );
}
