// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 4.8), dates: 2026-09-28 to 2026-09-29
// Scope: Generated the initial implementation for "SUP-01: supplier schema, admin CRUD, and
//   idempotent seed" (SUP-01); later new features.
// Author review: Patrick Thomas validated correctness and the implementation, and checked for fatal
//   errors and architectural conflicts, before committing.

import Papa from 'papaparse';

/**
 * Parses CSV text into rows of raw string cells via papaparse: it handles quoted
 * fields with embedded commas and newlines, escaped quotes (`""`), and both LF
 * and CRLF line endings. The seed file is read as latin1 so a stray Windows-1252
 * byte (the `\x92` apostrophe in "Prince George's Park") survives to be
 * normalized, rather than becoming U+FFFD.
 */
export function parseCsv(text: string): string[][] {
  const { data } = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  return data;
}

/** Turns the parsed rows into objects keyed by the header row. */
export function csvToRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((key, i) => {
      record[key] = (cells[i] ?? '').trim();
    });
    return record;
  });
}
