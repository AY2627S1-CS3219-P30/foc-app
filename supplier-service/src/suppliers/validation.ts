// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5, Claude Opus 4.8), dates: 2026-09-28 to 2026-11-04
// Scope: Generated the initial implementation for "SUP-01: supplier schema, admin CRUD, and
//   idempotent seed" (SUP-01, #187, SUP-02); later new features and bug fixes.
// Author review: Patrick Thomas and Jonus Ho validated correctness and the implementation, and
//   checked for fatal errors and architectural conflicts, before committing.

import { z } from 'zod';
import { ApiException } from '@foc/platform';
import { normalizeBuilding } from '../admin/normalize.js';
import { CAMPUS_BUILDINGS } from './campus-buildings.js';
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

/** Enough for a midday break and more, and it keeps the stored array bounded. */
export const MAX_PERIODS_PER_DAY = 4;

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = DAYS.length * MINUTES_PER_DAY;

const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

type Period = z.infer<typeof openingHoursEntry>;

/**
 * Where a period falls in the week, in minutes from Monday 00:00. One closing earlier than it opens
 * runs into the next day, so a late Sunday is two spans, the second at the start of the week. 23:59
 * is how the catalogue writes the end of the day, so it counts as midnight.
 */
function spansOfTheWeek({ day, opens, closes }: Period): [number, number][] {
  const midnight = DAYS.indexOf(day) * MINUTES_PER_DAY;
  const open = minutes(opens);
  const close = closes === '23:59' ? MINUTES_PER_DAY : minutes(closes);
  const start = midnight + open;
  const end = midnight + (close > open ? close : close + MINUTES_PER_DAY);
  return end <= MINUTES_PER_WEEK
    ? [[start, end]]
    : [
        [start, MINUTES_PER_WEEK],
        [0, end - MINUTES_PER_WEEK],
      ];
}

/**
 * A day holds zero or more periods (SS-FR1.1.3): none is a closed day, two a midday break. No two
 * periods may overlap, in whatever order they come, and a late close counts against the next day.
 * A problem is reported against the later of the entries that cause it, and a refused entry isn't
 * held against those after it, so one mistake doesn't make the rest of its day look wrong. They are
 * stored by day, then opening time, so every reader gets them in that order.
 */
const openingHoursSchema = z
  .array(openingHoursEntry)
  .max(DAYS.length * MAX_PERIODS_PER_DAY)
  .superRefine((entries, ctx) => {
    const seen: { period: Period; spans: [number, number][] }[] = [];
    entries.forEach((period, index) => {
      const { day, opens, closes } = period;
      const refuse = (code: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [index], params: { code }, message });
      if (opens === closes) {
        refuse('EMPTY_PERIOD', `${day} ${opens}–${closes} opens and closes at the same time.`);
        return;
      }
      const spans = spansOfTheWeek(period);
      const clash = seen.find((other) =>
        other.spans.some(([start, end]) => spans.some(([s, e]) => s < end && start < e)),
      );
      if (seen.filter((other) => other.period.day === day).length === MAX_PERIODS_PER_DAY) {
        refuse(
          'TOO_MANY_PERIODS',
          `${day} can have at most ${MAX_PERIODS_PER_DAY} opening periods.`,
        );
        return;
      }
      if (clash) {
        const { day: otherDay, opens: otherOpens, closes: otherCloses } = clash.period;
        refuse(
          'OVERLAPPING_HOURS',
          `${day} ${opens}–${closes} overlaps ${otherDay} ${otherOpens}–${otherCloses}.`,
        );
        return;
      }
      seen.push({ period, spans });
    });
  })
  .transform((entries) =>
    [...entries].sort(
      (a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.opens.localeCompare(b.opens),
    ),
  );

/** The always-present fields, shared by create (all required) and update (all optional). */
const baseFields = {
  name: text().trim().min(1).max(200),
  type: z.enum(SUPPLIER_TYPES),
  // Canonicalize the building the same way the seed does (alias, then a case-
  // and spacing-insensitive match on the campus list) and refuse one that is not
  // on the list (SS-FR1.1.2). `Com 2` and `COM2` both land on `COM2`, so the
  // unique `(lower(name), lower(building))` index catches the duplicate.
  building: text()
    .trim()
    .min(1)
    .max(200)
    .transform(normalizeBuilding)
    .refine((v) => CAMPUS_BUILDINGS.includes(v), {
      message: 'Building is not on the campus list.',
      params: { code: 'UNKNOWN_BUILDING' },
    }),
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

/** The fields a caller may sort by; ties are broken by name, then `supplierId`, for stable paging. */
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
 * same way create is, so `com2` matches the stored `COM2`. An off-list building
 * is not refused: it matches nothing, or a row stored before the list existed.
 * `sort`/`order` are trimmed and case-insensitive, and fall back to the stable
 * default rather than erroring on a cosmetic typo.
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

/** The `GET /buildings` query. Like the listing, a malformed `inUse` falls back rather than erroring. */
export const buildingsQuerySchema = z.object({
  inUse: z.stringbool().catch(false),
});

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
    const customCode = issue.code === 'custom' ? issue.params?.code : undefined;
    return [
      {
        field: issue.path.join('.') || fieldName,
        code: typeof customCode === 'string' ? customCode : issue.code.toUpperCase(),
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
