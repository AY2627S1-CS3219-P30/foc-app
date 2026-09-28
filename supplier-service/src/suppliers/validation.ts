import { z } from 'zod';
import { ApiException } from '@foc/platform';
import { DAYS, SUPPLIER_TYPES } from './types.js';

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export function validationFailed(details: FieldError[]): ApiException {
  return new ApiException(422, 'VALIDATION_FAILED', 'One or more fields are invalid.', details);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const openingHoursEntry = z.strictObject({
  day: z.enum(DAYS),
  opens: z.string().regex(HHMM, 'Time must be HH:MM (24-hour).'),
  closes: z.string().regex(HHMM, 'Time must be HH:MM (24-hour).'),
});

/** The always-present fields, shared by create (all required) and update (all optional). */
const baseFields = {
  name: z.string().trim().min(1).max(200),
  type: z.enum(SUPPLIER_TYPES),
  building: z.string().trim().min(1).max(200),
  floor: z.string().trim().min(1).max(50),
  locationDescription: z.string().trim().min(1).max(500),
  openingHours: z.array(openingHoursEntry).max(7).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  imageUrl: z.string().trim().url().max(2048).nullable(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).nullable(),
};

/** Latitude and longitude are stored as a pair; neither may appear without the other. */
const coordinatesPaired = (
  v: { latitude?: number | null; longitude?: number | null },
  ctx: z.RefinementCtx,
): void => {
  const hasLat = v.latitude !== undefined && v.latitude !== null;
  const hasLng = v.longitude !== undefined && v.longitude !== null;
  if (hasLat !== hasLng) {
    ctx.addIssue({
      code: 'custom',
      path: [hasLat ? 'longitude' : 'latitude'],
      message: 'Latitude and longitude must be provided together.',
    });
  }
};

export const supplierCreateSchema = z
  .strictObject({
    name: baseFields.name,
    type: baseFields.type,
    building: baseFields.building,
    floor: baseFields.floor,
    locationDescription: baseFields.locationDescription,
    openingHours: baseFields.openingHours.optional(),
    latitude: baseFields.latitude.optional(),
    longitude: baseFields.longitude.optional(),
    imageUrl: baseFields.imageUrl.optional(),
    tags: baseFields.tags.optional(),
  })
  .superRefine(coordinatesPaired);

export const supplierUpdateSchema = z
  .strictObject(baseFields)
  .partial()
  .superRefine((v, ctx) => {
    if (Object.keys(v).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['(body)'],
        message: 'Provide at least one field to change.',
      });
    }
    // On a patch, coordinates must move together: change both or clear both.
    if ('latitude' in v || 'longitude' in v) coordinatesPaired(v, ctx);
  });

export const supplierIdSchema = z.uuid();

/**
 * Parses `input` or throws the contract's `VALIDATION_FAILED` with one entry per
 * offending field — every invalid field at once, not just the first. Schemas are
 * strict, so an unknown field is reported rather than silently ignored.
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

/**
 * The `If-Match` header carries the version the caller last saw. It must be a
 * positive integer (optionally quoted as an ETag). A missing or malformed value
 * is a caller error, not a stale write.
 */
export function parseIfMatch(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    throw new ApiException(
      428,
      'PRECONDITION_REQUIRED',
      'An If-Match header with the supplier version is required to update.',
    );
  }
  const unquoted = raw.trim().replace(/^"(.*)"$/, '$1');
  const version = Number(unquoted);
  if (!Number.isInteger(version) || version < 1) {
    throw new ApiException(400, 'BAD_REQUEST', 'If-Match must be a positive integer version.');
  }
  return version;
}
