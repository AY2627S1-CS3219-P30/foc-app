import { z } from 'zod';
import { ApiException } from '@foc/platform';
import { normalizeBuilding } from '../admin/normalize.js';
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

/**
 * Each day may appear at most once: the model carries a single window per day,
 * so a repeated `day` is a caller mistake rather than a split shift (split
 * shifts are not supported). Reported against the first duplicate's position so
 * the error points at the offending entry.
 */
const openingHoursSchema = z
  .array(openingHoursEntry)
  .max(7)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (seen.has(entry.day)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'day'],
          message: `Duplicate opening hours for ${entry.day}; each day may appear at most once.`,
        });
      }
      seen.add(entry.day);
    });
  });

/** The always-present fields, shared by create (all required) and update (all optional). */
const baseFields = {
  name: z.string().trim().min(1).max(200),
  type: z.enum(SUPPLIER_TYPES),
  // Canonicalize the building the same way the seed does (collapse spacing and
  // apostrophes, then map known spellings onto one canonical name) BEFORE the
  // length check, so `Com 2` and `COM2` land on the same value and the unique
  // `(lower(name), lower(building))` index catches the resulting duplicate.
  // The transform runs first so min/max validate the canonical form.
  building: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .transform((v) => normalizeBuilding(v))
    .pipe(z.string().min(1).max(200)),
  floor: z.string().trim().min(1).max(50),
  locationDescription: z.string().trim().min(1).max(500),
  openingHours: openingHoursSchema.nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  // Only https URLs: Zod 4's `.url()` accepts any WHATWG scheme (including
  // `javascript:`, `data:`, `http:`), which would let an image field carry an
  // active or plaintext URL. Restrict the scheme, keep the trim, length cap and
  // nullable semantics.
  imageUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .nullable(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).nullable(),
};

/**
 * Latitude and longitude are stored as a pair. On create, neither may appear
 * without the other. On update, an explicit `null` still counts as "the key is
 * present": clearing just one side (`{ latitude: null }`) would null one column
 * while the other kept its value and trip the DB's `(latitude IS NULL) =
 * (longitude IS NULL)` check as an unmapped 500. So the rule keys on key
 * presence, not on the value: if either key is in the patch, both must be —
 * either two real numbers, or both explicitly `null` together.
 */
const coordinatesPaired = (
  v: { latitude?: number | null; longitude?: number | null },
  ctx: z.RefinementCtx,
): void => {
  const hasLatKey = 'latitude' in v;
  const hasLngKey = 'longitude' in v;
  if (hasLatKey !== hasLngKey) {
    ctx.addIssue({
      code: 'custom',
      path: [hasLatKey ? 'longitude' : 'latitude'],
      message: 'Latitude and longitude must be provided together.',
    });
    return;
  }
  // Both keys present: they must also agree on null-ness — two real numbers or
  // both explicitly null. One number and one null would null a single column
  // and trip the DB's `(latitude IS NULL) = (longitude IS NULL)` check as a 500.
  if (hasLatKey && (v.latitude === null) !== (v.longitude === null)) {
    ctx.addIssue({
      code: 'custom',
      path: [v.latitude === null ? 'latitude' : 'longitude'],
      message: 'Latitude and longitude must be set or cleared together.',
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

/** The fields a caller may sort by; each is tie-broken by `supplierId` for stable paging. */
export const SUPPLIER_SORTS = ['name', 'type', 'building', 'updatedAt'] as const;
export type SupplierSort = (typeof SUPPLIER_SORTS)[number];

// Page and page size are clamped, never rejected: an out-of-range or unparseable
// value falls back to a sane bound so a listing request always returns a page.
const page = z.coerce
  .number()
  .int()
  .transform((v) => Math.max(1, v))
  .catch(1);
const pageSize = z.coerce
  .number()
  .int()
  .transform((v) => Math.min(100, Math.max(1, v)))
  .catch(20);

/**
 * The `GET /suppliers` query. Filters (`type`, `building`) and the search term
 * are optional; `building` is canonicalized the same way create is, so `com2`
 * matches the stored `COM2`. `sort`/`order` fall back to the stable default
 * rather than erroring on a cosmetic typo.
 */
export const supplierListQuerySchema = z.object({
  page,
  pageSize,
  type: z.enum(SUPPLIER_TYPES).optional(),
  building: z
    .string()
    .trim()
    .min(1)
    .transform((v) => normalizeBuilding(v))
    .optional(),
  q: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(SUPPLIER_SORTS).catch('name'),
  order: z.enum(['asc', 'desc']).catch('asc'),
});

export type SupplierListQuery = z.output<typeof supplierListQuerySchema>;

/** Options for {@link parseOrThrow}. */
export interface ParseOptions {
  /** The `code` used for unrecognized (strict-mode) keys. */
  unknownFieldCode?: string;
  /**
   * The field name to report for issues whose path is empty. A scalar schema
   * (e.g. `z.uuid()`) has no path, so without this its issue would fall back to
   * `(body)`; pass e.g. `'id'` so a malformed path parameter is named correctly.
   */
  fieldName?: string;
}

/**
 * Parses `input` or throws the contract's `VALIDATION_FAILED` with one entry per
 * offending field — every invalid field at once, not just the first. Schemas are
 * strict, so an unknown field is reported rather than silently ignored.
 */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
  options: ParseOptions = {},
): z.output<S> {
  const { unknownFieldCode = 'UNKNOWN_FIELD', fieldName = '(body)' } = options;
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
        field: issue.path.join('.') || fieldName,
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
  // Require a plain positive decimal integer that fits Postgres int4. `Number`
  // would otherwise accept `0x1` (silently read as 1) or `99999999999` (an
  // integer that overflows int4 and surfaces as an unmapped 22003 → 500). Nine
  // digits keeps the value within int4's ~2.1e9 range without arithmetic.
  if (!/^\d{1,9}$/.test(unquoted)) {
    throw new ApiException(400, 'BAD_REQUEST', 'If-Match must be a positive integer version.');
  }
  const version = Number(unquoted);
  if (version < 1) {
    throw new ApiException(400, 'BAD_REQUEST', 'If-Match must be a positive integer version.');
  }
  return version;
}
