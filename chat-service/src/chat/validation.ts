// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-30 to 2026-11-03
// Scope: Generated the initial implementation for "channels and messages for an errand" (NTH-02,
//   #162, NTH-03); later bug fixes and new features.
// Author review: Anselm Long and Zhang Yuan validated correctness and the implementation, and
//   checked for fatal errors and architectural conflicts, before committing.

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

/** `seq` is a PostgreSQL integer, so anything larger would reach the database as a 500. */
export const MAX_SEQ = 2_147_483_647;
/** Counted in code points, as the browser counts them (ADR 0012). */
export const MAX_BODY = 280;

const pageSchema = z
  .object({
    after: z.coerce.number().int().min(0).max(MAX_SEQ).optional(),
    before: z.coerce.number().int().min(1).max(MAX_SEQ).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((page) => page.after === undefined || page.before === undefined, {
    message: 'Give after or before, not both.',
    path: ['before'],
  });
export type Page = z.infer<typeof pageSchema>;
export const parsePage = (query: unknown): Page => parse(pageSchema, query);

/**
 * 1 to MAX_BODY code points, not only whitespace (ADR 0012 §5). `.max()` would count UTF-16 units
 * and refuse 280 emoji. A NUL is refused too, because PostgreSQL would answer it with a 500.
 */
const sendSchema = z.strictObject({
  clientId: z.uuid(),
  body: z
    .string()
    .min(1)
    .refine((body) => [...body].length <= MAX_BODY, `At most ${MAX_BODY} characters.`)
    .refine((body) => body.trim() !== '', 'Must not be only whitespace.')
    .refine((body) => !body.includes('\0'), 'Must not contain a NUL character.'),
});
export type Send = z.infer<typeof sendSchema>;
export const parseSend = (body: unknown): Send => parse(sendSchema, body);

const markReadSchema = z.strictObject({ seq: z.number().int().min(0) });
export const parseMarkRead = (body: unknown): number => parse(markReadSchema, body).seq;
