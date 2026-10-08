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

/** The new password follows the registration policy: 12–128 characters, no composition rules. */
export const changePasswordSchema = z.strictObject({
  email: z.string().trim().min(1).max(254),
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});

/** The only fields a student may edit. Everything else — id, email, roles, status — is not editable by anyone through this endpoint. */
export const profileUpdateSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(50),
    faculty: z.string().trim().max(100).nullable(),
    avatarRef: z.string().trim().max(500).nullable(),
    contactPreference: z.enum(['IN_APP', 'EMAIL']),
    preferredMode: z.enum(['REQUESTER', 'COURIER']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to change.' });

export const reasonSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) });

/** `POST /auth/step-up`: the caller's current password, re-entered (ADR 0008). */
export const stepUpSchema = z.strictObject({ password: z.string().min(1).max(128) });

export const roleChangeSchema = z.strictObject({
  role: z.enum(['STUDENT', 'ADMIN']),
  reason: z.string().trim().min(1).max(500),
});

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);

export const userListQuerySchema = z.object({
  page,
  pageSize,
  status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED']).optional(),
  role: z.enum(['STUDENT', 'ADMIN']).optional(),
  q: z.string().trim().max(100).optional(),
});

export const introspectQuerySchema = z.strictObject({ sid: z.uuid(), sub: z.uuid() });

export const auditQuerySchema = z
  .object({
    page,
    pageSize,
    targetUserId: z.uuid().optional(),
    actorId: z.uuid().optional(),
    action: z
      .enum([
        'SUSPEND',
        'REACTIVATE',
        'ROLE_GRANT',
        'ROLE_REVOKE',
        'ADMIN_BOOTSTRAP',
        'ROLE_CHANGE_REQUESTED',
        'ROLE_CHANGE_REJECTED',
      ])
      .optional(),
    /** Inclusive bounds on when the action happened (RFC 3339). */
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), {
    message: '`from` must not be after `to`.',
    path: ['from'],
  });

export const roleRequestQuerySchema = z.object({
  page,
  pageSize,
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']).optional(),
});

export const readsQuerySchema = z.object({
  page,
  pageSize,
  actorId: z.uuid().optional(),
  targetUserId: z.uuid().optional(),
});

export const alertsQuerySchema = z.object({
  page,
  pageSize,
  kind: z
    .enum([
      'ROLE_CHANGE',
      'ADMIN_SUSPENDED',
      'ADMIN_REACTIVATED',
      'BULK_SUSPENSIONS',
      'SUSPENSION_LIMIT_REACHED',
      'BULK_READS',
    ])
    .optional(),
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
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
  unknownFieldCode = 'UNKNOWN_FIELD',
): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const details: FieldError[] = result.error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        field: key,
        code: unknownFieldCode,
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
