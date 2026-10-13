import { bearer, createApiClient, serviceUrl, unwrap } from './api-client';
import type { components, operations, paths } from './generated/supplier-service';

export const SUPPLIER_SERVICE_URL = serviceUrl(
  process.env.NEXT_PUBLIC_SUPPLIER_SERVICE_URL,
  'http://localhost:3002',
);

export type Supplier = components['schemas']['Supplier'];
export type SupplierType = components['schemas']['SupplierType'];
export type SupplierPage = components['schemas']['SupplierPage'];
export type SupplierInput = components['schemas']['SupplierInput'];
export type SupplierQuery = NonNullable<operations['listSuppliers']['parameters']['query']>;

export const supplierApi = createApiClient<paths>(SUPPLIER_SERVICE_URL, {
  notConfiguredMessage:
    'Suppliers are unavailable: NEXT_PUBLIC_SUPPLIER_SERVICE_URL is missing from this build.',
});

export type SupplierListing = {
  page: SupplierPage;
  /** Full details for each listed supplier whose detail call succeeded, in listing order. */
  suppliers: Supplier[];
  /** How many listed suppliers could not be loaded; they are left out of `suppliers`. */
  failed: number;
};

/**
 * One page of suppliers with full card details. The listing only carries summaries, so each card's
 * details are fetched separately; one failed detail call drops that card rather than the page. The
 * page fails only when the listing does or every detail call does. `signal` cancels every request.
 */
export async function listSupplierDetails(
  token: string,
  query: SupplierQuery,
  signal?: AbortSignal,
): Promise<SupplierListing> {
  const page = await unwrap(
    supplierApi.GET('/suppliers', { params: { query }, headers: bearer(token), signal }),
  );
  const results = await Promise.allSettled(
    page.items.map((item) =>
      unwrap(
        supplierApi.GET('/suppliers/{supplierId}', {
          params: { path: { supplierId: item.supplierId } },
          headers: bearer(token),
          signal,
        }),
      ),
    ),
  );
  signal?.throwIfAborted();
  const suppliers = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = results.length - suppliers.length;
  if (failed && !suppliers.length) throw (results[0] as PromiseRejectedResult).reason;
  return { page, suppliers, failed };
}
