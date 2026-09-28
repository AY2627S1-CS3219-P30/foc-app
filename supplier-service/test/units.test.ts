import { describe, expect, it } from 'vitest';
import { csvToRecords, parseCsv } from '../src/admin/csv.js';
import {
  normalizeBuilding,
  normalizeOpeningHours,
  normalizeTime,
  normalizeType,
  recordToSupplier,
} from '../src/admin/normalize.js';
import { uuidv5 } from '../src/admin/uuid.js';

describe('type normalization', () => {
  it('maps the messy source types onto the closed enum', () => {
    expect(normalizeType('Food')).toBe('FOOD');
    expect(normalizeType('Food/Coffee')).toBe('CAFE');
    expect(normalizeType('Printing')).toBe('PRINTING');
    expect(normalizeType('Shopping')).toBe('SHOPPING');
    expect(normalizeType('Landmark')).toBe('LANDMARK');
    expect(normalizeType('FOOD')).toBe('FOOD'); // already-canonical passes through
  });

  it('rejects an unknown type', () => {
    expect(() => normalizeType('Groceries')).toThrow(/Unknown supplier type/);
  });
});

describe('building normalization', () => {
  it('collapses inconsistent spellings onto one canonical name', () => {
    expect(normalizeBuilding('Com 2')).toBe('COM2');
    expect(normalizeBuilding('Com2')).toBe('COM2');
  });

  it('collapses both apostrophes in Prince George’s Park', () => {
    // ASCII apostrophe, Windows-1252 \x92, and the Unicode right single quote all coincide.
    expect(normalizeBuilding("Prince George's Park")).toBe("Prince George's Park");
    expect(normalizeBuilding('Prince George\x92s Park')).toBe("Prince George's Park");
    expect(normalizeBuilding('Prince George’s Park')).toBe("Prince George's Park");
  });

  it('leaves an unknown building tidy but intact', () => {
    expect(normalizeBuilding('  Central   Library ')).toBe('Central Library');
  });
});

describe('opening-hours normalization', () => {
  it('converts 0900hrs to 09:00', () => {
    expect(normalizeTime('0900hrs')).toBe('09:00');
    expect(normalizeTime('0815hrs')).toBe('08:15');
    expect(normalizeTime('2359hrs')).toBe('23:59');
  });

  it('treats 0000-2359 as an all-day window across every day', () => {
    const hours = normalizeOpeningHours('0000hrs', '2359hrs');
    expect(hours).toHaveLength(7);
    expect(hours![0]).toEqual({ day: 'MON', opens: '00:00', closes: '23:59' });
  });

  it('keeps a post-midnight close (opens > closes)', () => {
    const hours = normalizeOpeningHours('1100hrs', '0200hrs');
    expect(hours![0]).toMatchObject({ opens: '11:00', closes: '02:00' });
  });

  it('is null when both times are blank, and throws when only one is', () => {
    expect(normalizeOpeningHours('', '')).toBeNull();
    expect(() => normalizeOpeningHours('0900hrs', '')).toThrow(/Incomplete/);
    expect(() => normalizeTime('25:00')).toThrow(/out of range/);
  });
});

describe('CSV parsing', () => {
  it('handles quoted fields with embedded commas and CRLF endings', () => {
    const rows = parseCsv('a,b\r\n"x,y",z\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,y', 'z'],
    ]);
  });

  it('keys records by header and trims values', () => {
    const records = csvToRecords('Name,Type\r\n Cool Spot , Food \r\n');
    expect(records).toEqual([{ Name: 'Cool Spot', Type: 'Food' }]);
  });
});

describe('deterministic ids', () => {
  it('derives the same id for the same name+building every time', () => {
    const a = uuidv5('cool spot|COM2', 'f0c5a1de-0000-4000-8000-000000000001');
    const b = uuidv5('cool spot|COM2', 'f0c5a1de-0000-4000-8000-000000000001');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('a record and its normalized id are stable', () => {
    const record = {
      Name: 'Cool Spot',
      Type: 'Food',
      Building: 'Com2',
      Floor: '1',
      'Location Description': 'Opp LT16',
      Latitude: '1.2940156',
      Longitude: '103.7738478',
      StartingTime: '0900hrs',
      ClosingTime: '2130hrs',
      ImageURL: '',
    };
    const s = recordToSupplier(record);
    expect(s.building).toBe('COM2');
    expect(s.type).toBe('FOOD');
    expect(s.imageUrl).toBeNull();
    expect(s.supplierId).toBe(recordToSupplier(record).supplierId);
  });
});
