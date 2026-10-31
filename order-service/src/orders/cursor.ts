import { ApiException } from '@foc/platform';
import type { z } from 'zod';

/** An opaque page cursor: the last row's sort keys, as base64url JSON, like the Credit ledger's. */
export const encodeCursor = (keys: object): string =>
  Buffer.from(JSON.stringify(keys)).toString('base64url');

export function decodeCursor<T>(schema: z.ZodType<T>, value: string | undefined): T | undefined {
  if (value === undefined) return undefined;
  try {
    if (!value || value.length > 500) throw new Error('Invalid cursor length');
    return schema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new ApiException(400, 'INVALID_CURSOR', 'The page cursor is invalid.');
  }
}
