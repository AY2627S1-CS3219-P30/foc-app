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

export async function listSupplierDetails(
  token: string,
  query: SupplierQuery,
): Promise<{ page: SupplierPage; suppliers: Supplier[] }> {
  const page = await unwrap(
    supplierApi.GET('/suppliers', { params: { query }, headers: bearer(token) }),
  );
  const suppliers = await Promise.all(
    page.items.map((item) =>
      unwrap(
        supplierApi.GET('/suppliers/{supplierId}', {
          params: { path: { supplierId: item.supplierId } },
          headers: bearer(token),
        }),
      ),
    ),
  );
  return { page, suppliers };
}
