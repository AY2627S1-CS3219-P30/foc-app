import { createApiClient } from "./api-client";
import type { components, paths } from "./generated/supplier-service";

/** Inlined at build time, like the User Service's address (see user-api.ts). */
export const SUPPLIER_SERVICE_URL: string | null =
  process.env.NEXT_PUBLIC_SUPPLIER_SERVICE_URL ||
  (process.env.NODE_ENV === "production" ? null : "http://localhost:3002");

export type Supplier = components["schemas"]["Supplier"];
export type SupplierType = components["schemas"]["SupplierType"];
export type SupplierPage = components["schemas"]["SupplierPage"];

export const supplierApi = createApiClient<paths>(SUPPLIER_SERVICE_URL);
