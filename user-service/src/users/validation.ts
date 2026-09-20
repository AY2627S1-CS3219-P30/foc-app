import { z } from 'zod';
import { ApiException } from '@foc/platform';

export const registerSchema = z.strictObject({
  // Trimmed first: a pasted address with a stray space is still that address.
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(1).max(50),
});

export const loginSchema = z.strictObject({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});

export const activateSchema = z.strictObject({
  token: z.string().min(20).max(200),
});

export const userIdSchema = z.uuid();

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export function validationFailed(details: FieldError[]): ApiException {
  return new ApiException(422, 'VALIDATION_FAILED', 'One or more fields are invalid.', details);
}

/**
 * Parses `input` or throws the contract's `VALIDATION_FAILED` with one entry
 * per offending field. Schemas are strict, so an unknown field is rejected
 * rather than silently ignored. The `code` is derived from the zod issue; the
 * message never echoes the submitted value, so a rejected password is not
 * reflected back.
 */
export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const details: FieldError[] = result.error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        field: key,
        code: 'UNKNOWN_FIELD',
        message: 'This field is not accepted.',
      }));
    }
    return [
      {
        field: issue.path.join('.') || '(body)',
        code: issue.code.toUpperCase(),
        message: issue.message,
      },
    ];
  });
  throw validationFailed(details);
}
