// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-04
// Scope: Implementation for "store more than one opening period a day" (SUP-06, #376); also bug
//   fixes.
// Author review: Jonus Ho validated correctness and the implementation, and checked for fatal
//   errors and architectural conflicts, before committing.

import type { Supplier, SupplierType } from './supplier-api';

export const SUPPLIER_TYPES: SupplierType[] = ['FOOD', 'CAFE', 'PRINTING', 'SHOPPING', 'LANDMARK'];
export const TYPE_LABELS: Record<SupplierType, string> = {
  FOOD: 'Food',
  CAFE: 'Café',
  PRINTING: 'Printing',
  SHOPPING: 'Shopping',
  LANDMARK: 'Landmark',
};

export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
/** The contract's `maxItems` shared across the days; a test keeps them in step. */
export const MAX_PERIODS_PER_DAY = 4;

export function hoursLabel(hours: Supplier['openingHours']): string {
  if (!hours?.length) return 'Hours not provided';
  const days = new Map<string, string[]>();
  for (const { day, opens, closes } of hours) {
    days.set(day, [...(days.get(day) ?? []), `${opens}–${closes}`]);
  }
  return [...days].map(([day, periods]) => `${day} ${periods.join(', ')}`).join(' · ');
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
