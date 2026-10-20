import { bearer, createApiClient, unwrap } from "../src/lib/api-client";
import type { paths } from "../src/lib/generated/supplier-service";

// Compiled in CI independently of Next; this function is never executed.
export async function checkSupplierContract() {
  const api = createApiClient<paths>("http://supplier.test");
  const page = await unwrap(api.GET("/suppliers", {
    params: { query: { sort: "updatedAt", order: "desc", page: 1, pageSize: 20 } },
    headers: bearer("test-token"),
  }));
  for (const item of page.items) {
    const id: string = item.supplierId;
    const image: string | null = item.imageUrl;
    // @ts-expect-error List items deliberately omit detail-only fields.
    item.floor;
    void id;
    void image;
  }
  // @ts-expect-error Unknown sort fields must be rejected at compile time.
  api.GET("/suppliers", { params: { query: { sort: "unknown" } } });
}

// ADM-05: one account's errands must name the account, as requester or as courier.
export function checkAccountErrandQuery(api: import("../src/lib/admin-api").AdminApi) {
  api.accountErrands("t", { requesterId: "u", page: 1 });
  api.accountErrands("t", { courierId: "u" });
  // @ts-expect-error The Order Service refuses a query that names no account (422).
  api.accountErrands("t", { page: 1 });
}
