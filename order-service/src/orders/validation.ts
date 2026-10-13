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
