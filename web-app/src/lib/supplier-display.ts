import type { Supplier, SupplierType } from './supplier-api';

export const SUPPLIER_TYPES: SupplierType[] = ['FOOD', 'CAFE', 'PRINTING', 'SHOPPING', 'LANDMARK'];
export const TYPE_LABELS: Record<SupplierType, string> = {
  FOOD: 'Food',
  CAFE: 'Café',
  PRINTING: 'Printing',
  SHOPPING: 'Shopping',
  LANDMARK: 'Landmark',
};

// Canonical buildings in the two checked-in supplier seed files.
export const BUILDINGS = [
  'Block AS8',
  'Central Library',
  'COM2',
  'COM3',
  'Engineering Block E3',
  'Engineering Block E4',
  'Engineering Block EA',
  'Frontier',
  'Hon Sui Sen Memorial Library',
  'Innovation 4.0',
  'Kent Ridge MRT',
  'Medicine+Science Library',
  "Prince George's Park",
  'Techno Edge',
  'Terrace',
  'The Deck',
  'The Ridge',
  'University Town',
  'Yusof Ishak House',
] as const;

export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

export function hoursLabel(hours: Supplier['openingHours']): string {
  if (!hours?.length) return 'Hours not provided';
  return hours.map(({ day, opens, closes }) => `${day} ${opens}–${closes}`).join(' · ');
}

export function displayImageUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return url;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 5 || parts[2] !== 'blob') return url;
    return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`;
  } catch {
    return null;
  }
}
