// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 4.8, Claude Opus 5.5), dates: 2026-09-28 to 2026-09-30
// Scope: Generated the initial implementation for "SUP-01: supplier schema, admin CRUD, and
//   idempotent seed" (SUP-01, SUP-02); later new features.
// Author review: Patrick Thomas verified correctness, tested the change, and checked for fatal
//   errors and conflicts with our architecture before committing.

import type { suppliers } from '../db/schema.js';

/** The closed set of supplier categories (SUP-01). Enforced by the DB and the validator. */
export const SUPPLIER_TYPES = ['FOOD', 'CAFE', 'PRINTING', 'SHOPPING', 'LANDMARK'] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];

/** The days a supplier can post hours for. */
export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Day = (typeof DAYS)[number];

/**
 * One day's opening window. Times are `HH:MM` (24-hour). A `closes` that is less
 * than or equal to `opens` means the window runs past midnight into the next day
 * (e.g. `11:00`–`02:00`); `00:00`–`23:59` is treated as open all day.
 */
export interface OpeningHours {
  day: Day;
  opens: string;
  closes: string;
}

/** The fields an admin supplies to create a supplier. */
export interface SupplierInput {
  name: string;
  type: SupplierType;
  building: string;
  floor: string;
  locationDescription: string;
  openingHours?: OpeningHours[] | null;
  latitude?: number | null;
  longitude?: number | null;
  imageUrl?: string | null;
  tags?: string[] | null;
}

/**
 * A row as stored, inferred straight from the Drizzle schema so the column set
 * and its types stay in lockstep with the table definition. Keys are camelCase
 * (Drizzle's field names); `latitude`/`longitude` come back as numbers and the
 * timestamps as `Date`s. Imported type-only, so the types ⇄ schema reference
 * cycle is erased at compile time.
 */
export type SupplierRow = typeof suppliers.$inferSelect;

/** The public JSON shape returned by the API — camelCase, coordinates as numbers. */
export interface SupplierView {
  supplierId: string;
  name: string;
  type: SupplierType;
  building: string;
  floor: string;
  locationDescription: string;
  openingHours: OpeningHours[] | null;
  latitude: number | null;
  longitude: number | null;
  imageUrl: string | null;
  tags: string[] | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The lean shape a listing returns per supplier (SUP-02): enough to render a
 * card and to open the detail view, no more. Floor, location description,
 * opening hours and coordinates belong to `GET /suppliers/:id`.
 */
export interface SupplierListItem {
  supplierId: string;
  name: string;
  type: SupplierType;
  building: string;
  imageUrl: string | null;
}

export type SupplierListRow = Pick<
  SupplierRow,
  'supplierId' | 'name' | 'type' | 'building' | 'imageUrl'
>;

export const toSupplierListItem = (r: SupplierListRow): SupplierListItem => ({
  supplierId: r.supplierId,
  name: r.name,
  type: r.type,
  building: r.building,
  imageUrl: r.imageUrl,
});

// Coordinates are `double precision`, which both `pg` and PGlite return as JS
// numbers; the `string` case is belt-and-braces for any driver that maps them
// as text.
const num = (v: number | string | null): number | null =>
  v === null ? null : typeof v === 'number' ? v : Number(v);

export const toSupplierView = (r: SupplierRow): SupplierView => ({
  supplierId: r.supplierId,
  name: r.name,
  type: r.type,
  building: r.building,
  floor: r.floor,
  locationDescription: r.locationDescription,
  openingHours: r.openingHours,
  latitude: num(r.latitude),
  longitude: num(r.longitude),
  imageUrl: r.imageUrl,
  tags: r.tags,
  active: r.active,
  version: r.version,
  createdAt: new Date(r.createdAt).toISOString(),
  updatedAt: new Date(r.updatedAt).toISOString(),
});
