import { createApiClient, serviceUrl } from "./api-client";
import type { components, paths } from "./generated/supplier-service";

export const SUPPLIER_SERVICE_URL = serviceUrl(
  process.env.NEXT_PUBLIC_SUPPLIER_SERVICE_URL,
  "http://localhost:3002",
);

export type Supplier = components["schemas"]["Supplier"];
export type SupplierType = components["schemas"]["SupplierType"];
export type SupplierPage = components["schemas"]["SupplierPage"];

export const supplierApi = createApiClient<paths>(SUPPLIER_SERVICE_URL);
