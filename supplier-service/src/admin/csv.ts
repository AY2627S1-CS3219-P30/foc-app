/**
 * A small RFC-4180-ish CSV parser: enough for the supplier seed, and dependency
 * free. It handles quoted fields with embedded commas and newlines, escaped
 * quotes (`""`), and both LF and CRLF line endings. The seed file is read as
 * latin1 so a stray Windows-1252 byte (the `\x92` apostrophe in "Prince
 * George's Park") survives to be normalized, rather than becoming U+FFFD.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      // Swallow the \n of a \r\n pair.
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // A final field/row with no trailing newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully blank rows (e.g. a trailing newline at end of file).
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
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
