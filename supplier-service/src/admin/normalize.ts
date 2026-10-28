import {
  DAYS,
  type OpeningHours,
  type SupplierInput,
  type SupplierType,
} from '../suppliers/types.js';
import { CAMPUS_BUILDINGS } from '../suppliers/campus-buildings.js';
import { uuidv5 } from './uuid.js';

/** Namespace for the supplier seed's deterministic ids. Fixed forever; changing it re-keys every row. */
export const SUPPLIER_NAMESPACE = 'f0c5a1de-0000-4000-8000-000000000001';

/** A normalized record: the create input plus the stable id derived from its natural key. */
export interface SupplierSeed extends SupplierInput {
  supplierId: string;
}

/** The messy source `Type` values (and the canonical ones) mapped to the closed enum. */
const TYPE_MAP: Record<string, SupplierType> = {
  food: 'FOOD',
  'food/coffee': 'CAFE',
  coffee: 'CAFE',
  cafe: 'CAFE',
  printing: 'PRINTING',
  shopping: 'SHOPPING',
  landmark: 'LANDMARK',
};

export function normalizeType(raw: string): SupplierType {
  const key = raw.trim().toLowerCase();
  const type = TYPE_MAP[key];
  if (!type) throw new Error(`Unknown supplier type: ${JSON.stringify(raw)}`);
  return type;
}

/** Collapses apostrophe variants and whitespace so two spellings compare equal. */
const tidyBuilding = (raw: string): string =>
  raw
    .replace(/[‘’`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const buildingKey = (raw: string): string => tidyBuilding(raw).toLowerCase();

/**
 * Collapses the source's inconsistent building spellings onto one canonical name
 * per building, so the building filter shows each building once and the
 * name+building duplicate rule catches real duplicates. `Com 2`/`Com2` become
 * `COM2`; both apostrophes in "Prince George's Park" become one spelling.
 */
const BUILDING_MAP: Record<string, string> = {
  'com 2': 'COM2',
  com2: 'COM2',
  com3: 'COM3',
  "prince george's park": "Prince George's Park",
  'innovation4.0': 'Innovation 4.0',
  'innovation 4.0': 'Innovation 4.0',
  'blk as8': 'Block AS8',
  'block as8': 'Block AS8',
  terrace: 'Terrace',
  'the terrace': 'Terrace',
};

const CANONICAL_BUILDINGS = new Map<string, string>([
  ...CAMPUS_BUILDINGS.map((b) => [buildingKey(b), b] as const),
  ...Object.entries(BUILDING_MAP),
]);

/**
 * Resolves a spelling onto its campus building: an alias first, then a case- and
 * spacing-insensitive match on {@link CAMPUS_BUILDINGS}. A building off the list
 * comes back tidied but unresolved, for validation to refuse.
 */
export function normalizeBuilding(raw: string): string {
  return CANONICAL_BUILDINGS.get(buildingKey(raw)) ?? tidyBuilding(raw);
}

/** `0900hrs` → `09:00`; also accepts an already-formatted `HH:MM`. Empty → null. */
export function normalizeTime(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return null;
  let hours: number;
  let minutes: number;
  const hrs = /^(\d{1,2})(\d{2})\s*hrs?$/i.exec(s);
  const colon = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hrs) {
    hours = Number(hrs[1]);
    minutes = Number(hrs[2]);
  } else if (colon) {
    hours = Number(colon[1]);
    minutes = Number(colon[2]);
  } else {
    throw new Error(`Unrecognized time: ${JSON.stringify(raw)}`);
  }
  if (hours > 23 || minutes > 59) throw new Error(`Time out of range: ${JSON.stringify(raw)}`);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Builds per-day opening hours from a single start/close pair applied to all
 * seven days (the source has no per-day data). `0000`–`2359` is open all day; a
 * close at or before the open (e.g. `1100`–`0200`) runs past midnight.
 */
export function normalizeOpeningHours(start: string, close: string): OpeningHours[] | null {
  const opens = normalizeTime(start);
  const closes = normalizeTime(close);
  if (opens === null && closes === null) return null;
  if (opens === null || closes === null) {
    throw new Error(`Incomplete opening hours: start=${start} close=${close}`);
  }
  return DAYS.map((day) => ({ day, opens, closes }));
}

const parseCoordinate = (raw: string): number | null => {
  const s = raw.trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Unrecognized coordinate: ${JSON.stringify(raw)}`);
  return n;
};

/** Turns one seed CSV record into a normalized, id-stamped supplier. */
export function recordToSupplier(record: Record<string, string>): SupplierSeed {
  const name = (record.Name ?? '').trim();
  const building = normalizeBuilding(record.Building ?? '');
  const latitude = parseCoordinate(record.Latitude ?? '');
  const longitude = parseCoordinate(record.Longitude ?? '');
  if ((latitude === null) !== (longitude === null)) {
    throw new Error(`Incomplete coordinates for ${JSON.stringify(name)}`);
  }
  return {
    supplierId: uuidv5(`${name.toLowerCase()}|${building}`, SUPPLIER_NAMESPACE),
    name,
    type: normalizeType(record.Type ?? ''),
    building,
    floor: (record.Floor ?? '').trim(),
    locationDescription: (record['Location Description'] ?? '').trim(),
    openingHours: normalizeOpeningHours(record.StartingTime ?? '', record.ClosingTime ?? ''),
    latitude,
    longitude,
    imageUrl: (record.ImageURL ?? '').trim() || null,
    tags: null,
  };
}
