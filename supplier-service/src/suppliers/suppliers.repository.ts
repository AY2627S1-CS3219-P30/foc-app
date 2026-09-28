import type { Queryable } from '../db/db.js';
import type { SupplierInput, SupplierRow } from './types.js';

/** Postgres error code for a unique-constraint violation, shared by `pg` and PGlite. */
export const UNIQUE_VIOLATION = '23505';

export const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  const e = err as { code?: string; constraint?: string } | null;
  if (!e || e.code !== UNIQUE_VIOLATION) return false;
  return constraint ? e.constraint === constraint : true;
};

/** A record ready to store: the validated input plus its stable primary key. */
export interface NewSupplier extends SupplierInput {
  supplierId: string;
}

/** Columns an update may set, in the fixed camel→snake map. Values never come from input keys. */
const UPDATABLE = {
  name: { column: 'name', json: false },
  type: { column: 'type', json: false },
  building: { column: 'building', json: false },
  floor: { column: 'floor', json: false },
  locationDescription: { column: 'location_description', json: false },
  openingHours: { column: 'opening_hours', json: true },
  latitude: { column: 'latitude', json: false },
  longitude: { column: 'longitude', json: false },
  imageUrl: { column: 'image_url', json: false },
  tags: { column: 'tags', json: true },
} as const;

const jsonParam = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

/**
 * All SQL for the suppliers tables. Every function takes a {@link Queryable} so
 * the service can run several of them in one transaction.
 */
export const suppliersRepository = {
  /** Inserts a supplier. Throws the unique violation on an active name+building clash. */
  async insert(q: Queryable, s: NewSupplier): Promise<SupplierRow> {
    const { rows } = await q.query<SupplierRow>(
      `INSERT INTO suppliers
         (supplier_id, name, type, building, floor, location_description,
          opening_hours, latitude, longitude, image_url, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb)
       RETURNING *`,
      [
        s.supplierId,
        s.name,
        s.type,
        s.building,
        s.floor,
        s.locationDescription,
        jsonParam(s.openingHours ?? null),
        s.latitude ?? null,
        s.longitude ?? null,
        s.imageUrl ?? null,
        jsonParam(s.tags ?? null),
      ],
    );
    return rows[0]!;
  },

  /** Insert-if-absent, keyed on the stable primary key. Returns the row only when it was created. */
  async insertIfAbsent(q: Queryable, s: NewSupplier): Promise<SupplierRow | null> {
    const { rows } = await q.query<SupplierRow>(
      `INSERT INTO suppliers
         (supplier_id, name, type, building, floor, location_description,
          opening_hours, latitude, longitude, image_url, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb)
       ON CONFLICT (supplier_id) DO NOTHING
       RETURNING *`,
      [
        s.supplierId,
        s.name,
        s.type,
        s.building,
        s.floor,
        s.locationDescription,
        jsonParam(s.openingHours ?? null),
        s.latitude ?? null,
        s.longitude ?? null,
        s.imageUrl ?? null,
        jsonParam(s.tags ?? null),
      ],
    );
    return rows[0] ?? null;
  },

  /** A single supplier by id, active or not — a deactivated supplier stays resolvable. */
  async findById(q: Queryable, id: string): Promise<SupplierRow | null> {
    const { rows } = await q.query<SupplierRow>(`SELECT * FROM suppliers WHERE supplier_id = $1`, [
      id,
    ]);
    return rows[0] ?? null;
  },

  /** Active suppliers only, for listings (SUP-02 adds filter/sort/pagination on top). */
  async listActive(q: Queryable): Promise<SupplierRow[]> {
    const { rows } = await q.query<SupplierRow>(
      `SELECT * FROM suppliers WHERE active ORDER BY name, building`,
    );
    return rows;
  },

  /**
   * Applies only the fields present, bumping the version and `updated_at`, but
   * only if the row is still at `expectedVersion`. Returns the new row, or null
   * if the version did not match (a stale edit) or the row does not exist.
   */
  async update(
    q: Queryable,
    id: string,
    expectedVersion: number,
    changes: Partial<SupplierInput>,
  ): Promise<SupplierRow | null> {
    const sets: string[] = ['version = version + 1', 'updated_at = now()'];
    const params: unknown[] = [id, expectedVersion];
    for (const [key, meta] of Object.entries(UPDATABLE)) {
      if (!(key in changes)) continue;
      const value = changes[key as keyof SupplierInput];
      params.push(meta.json ? jsonParam(value) : (value ?? null));
      sets.push(`${meta.column} = $${params.length}${meta.json ? '::jsonb' : ''}`);
    }
    const { rows } = await q.query<SupplierRow>(
      `UPDATE suppliers SET ${sets.join(', ')}
       WHERE supplier_id = $1 AND version = $2
       RETURNING *`,
      params,
    );
    return rows[0] ?? null;
  },

  /** Soft-deactivates an active supplier. Returns the row, or null if it was not active. */
  async deactivate(q: Queryable, id: string): Promise<SupplierRow | null> {
    const { rows } = await q.query<SupplierRow>(
      `UPDATE suppliers SET active = false, version = version + 1, updated_at = now()
       WHERE supplier_id = $1 AND active
       RETURNING *`,
      [id],
    );
    return rows[0] ?? null;
  },

  async findIdempotent(q: Queryable, key: string): Promise<string | null> {
    const { rows } = await q.query<{ supplier_id: string }>(
      `SELECT supplier_id FROM supplier_idempotency_keys WHERE idempotency_key = $1`,
      [key],
    );
    return rows[0]?.supplier_id ?? null;
  },

  /** Claims a key for a supplier. Returns false if another request already claimed it. */
  async claimIdempotencyKey(q: Queryable, key: string, supplierId: string): Promise<boolean> {
    const { rows } = await q.query(
      `INSERT INTO supplier_idempotency_keys (idempotency_key, supplier_id)
       VALUES ($1, $2)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [key, supplierId],
    );
    return rows.length > 0;
  },
};
