/**
 * The campus buildings a supplier may be in (SS-FR1.1.2), in display order.
 * Seeded from the canonical buildings of `data/csv/supplier-seed-*.csv`; a new
 * building is opened by adding it here, and `GET /buildings` serves it as is.
 */
export const CAMPUS_BUILDINGS: readonly string[] = [
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
];
