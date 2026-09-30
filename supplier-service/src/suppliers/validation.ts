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

/** Postgres rejects `\0` in text, which would surface as a 500; refuse it up front as a 422. */
const rejectNul = <T extends z.ZodType<string>>(schema: T): T =>
  schema.refine((v) => !v.includes('\0'), 'Must not contain a NUL character.');
const text = () => rejectNul(z.string());

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
  name: text().trim().min(1).max(200),
  type: z.enum(SUPPLIER_TYPES),
  // Canonicalize the building the same way the seed does (collapse spacing and
  // apostrophes, then map known spellings onto one canonical name) BEFORE the
  // length check, so `Com 2` and `COM2` land on the same value and the unique
  // `(lower(name), lower(building))` index catches the resulting duplicate.
  // The transform runs first so min/max validate the canonical form.
  building: text()
    .trim()
    .min(1)
    .max(200)
    .transform((v) => normalizeBuilding(v))
    .pipe(z.string().min(1).max(200)),
  floor: text().trim().min(1).max(50),
  locationDescription: text().trim().min(1).max(500),
  openingHours: openingHoursSchema.nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  // Only https URLs: Zod 4's `.url()` accepts any WHATWG scheme (including
  // `javascript:`, `data:`, `http:`), which would let an image field carry an
  // active or plaintext URL. Restrict the scheme, keep the trim, length cap and
  // nullable semantics.
  imageUrl: rejectNul(z.url({ protocol: /^https$/ }).max(2048)).nullable(),
  tags: z.array(text().trim().min(1).max(50)).max(50).nullable(),
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

/** The fields a caller may sort by; ties are broken by name, building, then `supplierId`, for stable paging. */
export const SUPPLIER_SORTS = ['name', 'type', 'building', 'updatedAt'] as const;
export type SupplierSort = (typeof SUPPLIER_SORTS)[number];

// Page and page size are clamped, never rejected: an out-of-range value is pulled
// into bounds and anything that is not a plain decimal integer (`''`, `0x2`, `1e3`,
// a repeated key) falls back to the default, so a listing request always returns a page.
const count = (fallback: number, clamp: (n: number) => number) =>
  z
    .string()
    .trim()
    .regex(/^-?\d{1,9}$/)
    .transform((v) => clamp(Number(v)))
    .catch(fallback);

/** An optional filter where an empty or whitespace-only value (a cleared input) means unset. */
const optionalFilter = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    schema.optional(),
  );

/**
 * The `GET /suppliers` query. Filters (`type`, `building`) and the search term
 * are optional; `type` is case-insensitive and `building` is canonicalized the
 * same way create is, so `com2` matches the stored `COM2`. `sort`/`order` are
 * trimmed and case-insensitive, and fall back to the stable default rather than
 * erroring on a cosmetic typo.
 */
export const supplierListQuerySchema = z.object({
  page: count(1, (v) => Math.max(1, v)),
  pageSize: count(20, (v) => Math.min(100, Math.max(1, v))),
  type: optionalFilter(z.string().trim().toUpperCase().pipe(z.enum(SUPPLIER_TYPES))),
  building: optionalFilter(text().trim().transform(normalizeBuilding)),
  q: optionalFilter(text().trim().max(200)),
  sort: z
    .string()
    .trim()
    .transform((v) => SUPPLIER_SORTS.find((s) => s.toLowerCase() === v.toLowerCase()))
    .pipe(z.enum(SUPPLIER_SORTS))
    .catch('name'),
  order: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['asc', 'desc']))
    .catch('asc'),
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

const IDEMPOTENCY_KEY_MAX = 200;

/**
 * The optional `Idempotency-Key` header, trimmed. A blank key means none. The key
 * is capped because it is stored and hashed into an advisory lock.
 */
export function parseIdempotencyKey(raw: string | undefined): string | undefined {
  const key = raw?.trim();
  if (!key) return undefined;
  if (key.length > IDEMPOTENCY_KEY_MAX) {
    throw new ApiException(
      400,
      'BAD_REQUEST',
      `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX} characters.`,
    );
  }
  return key;
}
