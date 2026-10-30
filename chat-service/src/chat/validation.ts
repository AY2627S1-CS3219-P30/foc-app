import { ApiException } from '@foc/platform';
import { z } from 'zod';

const orderIdSchema = z.uuid();

export function parseOrderId(id: string): string {
  const parsed = orderIdSchema.safeParse(id);
  if (!parsed.success) throw new ApiException(400, 'INVALID_ORDER_ID', 'Order ID must be a UUID.');
  return parsed.data;
}

/** Every invalid field at once, as `{ field, code, message }`, like the other services. */
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new ApiException(
    422,
    'VALIDATION_FAILED',
    'One or more fields are invalid.',
    parsed.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      code: issue.code,
      message: issue.message,
    })),
  );
}

const pageSchema = z
  .object({
    after: z.coerce.number().int().min(0).optional(),
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((page) => page.after === undefined || page.before === undefined, {
    message: 'Give after or before, not both.',
    path: ['before'],
  });
export type Page = z.infer<typeof pageSchema>;
export const parsePage = (query: unknown): Page => parse(pageSchema, query);

/**
 * The shape only. The 280-character limit and refusing a body of only whitespace come with the
 * other limits in #163; a NUL is refused here, because PostgreSQL would answer it with a 500.
 */
const sendSchema = z.strictObject({
  clientId: z.uuid(),
  body: z
    .string()
    .min(1)
    .refine((body) => !body.includes('\0'), 'Must not contain a NUL character.'),
});
export type Send = z.infer<typeof sendSchema>;
export const parseSend = (body: unknown): Send => parse(sendSchema, body);

const markReadSchema = z.strictObject({ seq: z.number().int().min(0) });
export const parseMarkRead = (body: unknown): number => parse(markReadSchema, body).seq;
