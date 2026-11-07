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

// ORD-15, ADM-06: one errand list, by account, status or both, or every errand.
export function checkErrandQuery(api: import("../src/lib/admin-api").AdminApi) {
  api.errands("t", { requesterId: "u", status: ["OPEN", "ACCEPTED"], pageSize: 10 });
  api.errands("t", { courierId: "u", before: "0198a1c2-0000-7000-8000-00000000e001" });
  api.errands("t", {});
  // @ts-expect-error A status the Order Service does not know is refused at compile time.
  api.errands("t", { status: ["NOPE"] });
}

// #309: the password is chosen at activation, not at sign-up.
export function checkPasswordAtActivation(api: import("../src/lib/user-api").UserApi) {
  api.register({ email: "e0123456@u.nus.edu", displayName: "Alex" });
  // @ts-expect-error Sign-up takes no password.
  api.register({ email: "e0123456@u.nus.edu", displayName: "Alex", password: "correct-horse-battery" });
  api.activate("token", "correct-horse-battery");
  // @ts-expect-error Activation needs the password the student chooses.
  api.activate("token");
}

// N1.2: all chat calls are checked against the agreed contract.
export function checkChat(api: import("openapi-fetch").Client<import("../src/lib/generated/chat-service").paths>) {
  api.GET("/channels/{orderId}/messages", { params: { path: { orderId: "id" }, query: { after: 2, limit: 100 } } });
  api.POST("/channels/{orderId}/messages", { params: { path: { orderId: "id" } }, body: { clientId: "uuid", body: "Hello" } });
  // @ts-expect-error Sending must carry an idempotency clientId.
  api.POST("/channels/{orderId}/messages", { params: { path: { orderId: "id" } }, body: { body: "Hello" } });
}
