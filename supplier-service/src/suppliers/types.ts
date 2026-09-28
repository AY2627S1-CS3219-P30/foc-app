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
 * A row as stored. `latitude`/`longitude` come back as strings from `pg`'s
 * numeric mapping. A `type` alias, not an `interface`, so it satisfies the
 * repository's `Row` (`Record<string, unknown>`) query constraint.
 */
export type SupplierRow = {
  supplier_id: string;
  name: string;
  type: SupplierType;
  building: string;
  floor: string;
  location_description: string;
  opening_hours: OpeningHours[] | null;
  latitude: number | string | null;
  longitude: number | string | null;
  image_url: string | null;
  tags: string[] | null;
  active: boolean;
  version: number;
  created_at: string | Date;
  updated_at: string | Date;
};

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

const num = (v: number | string | null): number | null =>
  v === null ? null : typeof v === 'number' ? v : Number(v);

export const toSupplierView = (r: SupplierRow): SupplierView => ({
  supplierId: r.supplier_id,
  name: r.name,
  type: r.type,
  building: r.building,
  floor: r.floor,
  locationDescription: r.location_description,
  openingHours: r.opening_hours,
  latitude: num(r.latitude),
  longitude: num(r.longitude),
  imageUrl: r.image_url,
  tags: r.tags,
  active: r.active,
  version: r.version,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});
