import { readFile } from 'node:fs/promises';
import { csvToRecords } from './csv.js';
import { recordToSupplier, type SupplierSeed } from './normalize.js';
import { parseOrThrow, supplierCreateSchema } from '../suppliers/validation.js';

/**
 * The seed sources, in order. The first is the messy vendor template (kept
 * verbatim so the suite proves the normalizer handles the real source); the
 * second holds the supplementary records that take the catalogue past
 * SS-FR4.1.1's floor of ≥30 active suppliers across ≥10 buildings and every
 * type, including the LANDMARK pickup points that the template has none of.
 *
 * Each entry carries its own encoding because the two files are authored
 * differently and must be decoded differently:
 *   - The vendor template was exported by an external tool as Windows-1252 /
 *     latin1 and contains at least one stray byte (0x92, a curly apostrophe in
 *     that codepage) that is not valid UTF-8, so it MUST be read as 'latin1'.
 *   - The additions file is ours; editors save it as UTF-8. Reading it as
 *     'latin1' is harmless while it stays pure ASCII, but the moment someone
 *     adds a multi-byte character (e.g. `Café` or a curly apostrophe) latin1
 *     would decode each UTF-8 byte separately and store mojibake (`CafÃ©`).
 *     Decoding it as 'utf-8' keeps such characters intact.
 */
const SEED_FILES: ReadonlyArray<{ file: string; encoding: BufferEncoding }> = [
  { file: 'supplier-seed-data.csv', encoding: 'latin1' },
  { file: 'supplier-seed-additions.csv', encoding: 'utf-8' },
];

/** repoRoot/data/csv, resolved from this module so it works from src (tsx) and dist alike. */
const defaultSeedDir = (): URL => new URL('../../../data/csv/', import.meta.url);

/**
 * Reads every seed file, normalizes each row and validates it against the same
 * schema the API uses, then de-duplicates on the normalized name+building so two
 * sources cannot introduce the same supplier twice. Throws with the file and row
 * named if any row fails to normalize or validate.
 */
export async function loadSeedSuppliers(dir: URL = defaultSeedDir()): Promise<SupplierSeed[]> {
  const suppliers: SupplierSeed[] = [];
  const seen = new Set<string>();

  for (const { file, encoding } of SEED_FILES) {
    // Decode per file: the vendor template is latin1, our additions are UTF-8
    // (see the SEED_FILES comment for why mixing them up corrupts characters).
    const text = await readFile(new URL(file, dir), encoding);
    const records = csvToRecords(text);
    records.forEach((record, i) => {
      let seed: SupplierSeed;
      try {
        seed = recordToSupplier(record);
        const { supplierId: _id, ...input } = seed;
        parseOrThrow(supplierCreateSchema, input);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`${file} row ${i + 2}: ${detail}`);
      }
      const key = `${seed.name.toLowerCase()}|${seed.building}`;
      if (seen.has(key)) return; // first source wins on a cross-file duplicate
      seen.add(key);
      suppliers.push(seed);
    });
  }
  return suppliers;
}
