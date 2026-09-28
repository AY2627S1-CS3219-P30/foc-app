import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiException } from '@foc/platform';
import { DB, type Db } from '../db/db.js';
import { isUniqueViolation, suppliersRepository as repo } from './suppliers.repository.js';
import { validationFailed } from './validation.js';
import { toSupplierView, type SupplierInput, type SupplierView } from './types.js';

const NAME_BUILDING_INDEX = 'suppliers_name_building_active_key';

const notFound = () => new ApiException(404, 'NOT_FOUND', 'Supplier not found.');

/** The active name+building clash surfaces as a field-level 422, like any other validation error. */
const duplicate = () =>
  validationFailed([
    {
      field: 'name',
      code: 'DUPLICATE_NAME_BUILDING',
      message: 'An active supplier with this name already exists in this building.',
    },
  ]);

export interface CreateResult {
  supplier: SupplierView;
  /** True when an Idempotency-Key replay returned the original supplier rather than creating one. */
  replayed: boolean;
}

/**
 * Supplier catalogue operations (SUP-01). Every mutation runs in one
 * transaction, so a row commits fully or not at all: a failure leaves nothing
 * half-written and surfaces through the shared error envelope.
 */
@Injectable()
export class SuppliersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(): Promise<SupplierView[]> {
    const rows = await repo.listActive(this.db);
    return rows.map(toSupplierView);
  }

  async getById(id: string): Promise<SupplierView> {
    const row = await repo.findById(this.db, id);
    if (!row) throw notFound();
    return toSupplierView(row);
  }

  async create(input: SupplierInput, idempotencyKey?: string): Promise<CreateResult> {
    return this.db.transaction(async (tx) => {
      if (idempotencyKey) {
        // Serialize same-key requests so a concurrent replay waits for the first
        // to commit, then finds its result below instead of racing to insert.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotencyKey]);
        const existing = await repo.findIdempotent(tx, idempotencyKey);
        if (existing) {
          const row = await repo.findById(tx, existing);
          return { supplier: toSupplierView(row!), replayed: true };
        }
      }

      const supplierId = randomUUID();
      let row;
      try {
        row = await repo.insert(tx, { supplierId, ...input });
      } catch (err) {
        if (isUniqueViolation(err, NAME_BUILDING_INDEX)) throw duplicate();
        throw err;
      }

      if (idempotencyKey) {
        await repo.claimIdempotencyKey(tx, idempotencyKey, supplierId);
      }
      return { supplier: toSupplierView(row), replayed: false };
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    changes: Partial<SupplierInput>,
  ): Promise<SupplierView> {
    const row = await this.db.transaction(async (tx) => {
      let updated;
      try {
        updated = await repo.update(tx, id, expectedVersion, changes);
      } catch (err) {
        if (isUniqueViolation(err, NAME_BUILDING_INDEX)) throw duplicate();
        throw err;
      }
      if (updated) return updated;
      // Nothing updated: tell a missing supplier apart from a stale version, so
      // the caller knows whether to reload or to stop.
      const current = await repo.findById(tx, id);
      if (!current) throw notFound();
      throw new ApiException(
        412,
        'STALE_VERSION',
        `The supplier has changed since version ${expectedVersion}. Reload it and retry.`,
      );
    });
    return toSupplierView(row);
  }

  /** Soft deactivation (SUP-01): the row stays fetchable by id but leaves listings. Idempotent. */
  async deactivate(id: string): Promise<SupplierView> {
    const row = await this.db.transaction(async (tx) => {
      const deactivated = await repo.deactivate(tx, id);
      if (deactivated) return deactivated;
      const current = await repo.findById(tx, id);
      if (!current) throw notFound();
      return current; // already inactive — no second change, no error
    });
    return toSupplierView(row);
  }
}
