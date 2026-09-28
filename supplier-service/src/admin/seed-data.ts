import { readFile } from 'node:fs/promises';
import { csvToRecords } from './csv.js';
import { recordToSupplier, type SupplierSeed } from './normalize.js';
import { parseOrThrow, supplierCreateSchema } from '../suppliers/validation.js';

/**
 * The seed sources, in order. The first is the messy template (kept verbatim so
 * the suite proves the normalizer handles the real source); the second holds the
 * supplementary records that take the catalogue past SS-FR4.1.1's floor of ≥30
 * active suppliers across ≥10 buildings and every type, including the LANDMARK
 * pickup points that the template has none of.
 */
const SEED_FILES = ['supplier-seed-data.csv', 'supplier-seed-additions.csv'];

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

  for (const file of SEED_FILES) {
    const text = await readFile(new URL(file, dir), 'latin1');
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
