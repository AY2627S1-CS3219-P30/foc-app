import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '@foc/platform';
import { z } from 'zod';
import { env } from '../config.js';
import type { SupplierSnapshot } from './types.js';

export const SUPPLIER_FETCH = Symbol('SUPPLIER_FETCH');

const supplierResponse = z.object({
  supplierId: z.uuid(),
  name: z.string().min(1),
  type: z.string().min(1),
  building: z.string().min(1),
  floor: z.string().min(1),
  locationDescription: z.string().min(1),
  active: z.boolean(),
});

const invalidSupplier = (message: string) =>
  new ApiException(422, 'INVALID_SUPPLIER', message, [
    { field: 'supplierId', code: 'INVALID_SUPPLIER', message },
  ]);

@Injectable()
export class SupplierClient {
  constructor(@Inject(SUPPLIER_FETCH) private readonly fetchImpl: typeof fetch) {}

  async getActive(supplierId: string, authorization: string): Promise<SupplierSnapshot> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${env.SUPPLIER_SERVICE_URL.replace(/\/$/, '')}/suppliers/${supplierId}`,
        {
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(2_000),
        },
      );
    } catch {
      throw new ApiException(
        503,
        'SUPPLIER_SERVICE_UNAVAILABLE',
        'The supplier could not be verified. Try again later.',
      );
    }

    if (response.status === 404) throw invalidSupplier('The supplier does not exist.');
    if (!response.ok) {
      throw new ApiException(
        503,
        'SUPPLIER_SERVICE_UNAVAILABLE',
        'The supplier could not be verified. Try again later.',
      );
    }

    const parsed = supplierResponse.safeParse(await response.json());
    if (!parsed.success || parsed.data.supplierId !== supplierId) {
      throw new ApiException(
        503,
        'SUPPLIER_CONTRACT_INVALID',
        'The supplier response could not be verified.',
      );
    }
    if (!parsed.data.active) throw invalidSupplier('The supplier is not active.');

    const { active: _, ...snapshot } = parsed.data;
    return snapshot;
  }
}
