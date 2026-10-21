import { bearer, createApiClient, serviceUrl, unwrap } from "./api-client";
import type {
  components as CreditComponents,
  paths as CreditPaths,
} from "./generated/credit-service";
import type { components, paths } from "./generated/order-service";

export const ORDER_SERVICE_URL = serviceUrl(
  process.env.NEXT_PUBLIC_ORDER_SERVICE_URL,
  "http://localhost:3003",
);
export const CREDIT_SERVICE_URL = serviceUrl(
  process.env.NEXT_PUBLIC_CREDIT_SERVICE_URL,
  "http://localhost:3004",
);

export type Order = components["schemas"]["Order"];
export type OrderStatus = Order["status"];
export type OrderItem = components["schemas"]["OrderItem"];
export type CreateOrder = components["schemas"]["CreateOrder"];
export type Wallet = CreditComponents["schemas"]["Wallet"];

const orderApi = createApiClient<paths>(ORDER_SERVICE_URL, {
  notConfiguredMessage:
    "Errands are unavailable: NEXT_PUBLIC_ORDER_SERVICE_URL is missing from this build.",
});
const creditApi = createApiClient<CreditPaths>(CREDIT_SERVICE_URL, {
  notConfiguredMessage:
    "Wallets are unavailable: NEXT_PUBLIC_CREDIT_SERVICE_URL is missing from this build.",
});

/** `201` creates a `PENDING_CREDIT` order; `200` replays the one this key already created. */
export async function createOrder(token: string, body: CreateOrder, idempotencyKey: string) {
  const call = orderApi.POST("/orders", {
    params: { header: { "Idempotency-Key": idempotencyKey } },
    body,
    headers: bearer(token),
  });
  const order = await unwrap(call);
  return { order, replayed: (await call).response.status === 200 };
}

export const getOrder = (token: string, orderId: string) =>
  unwrap(
    orderApi.GET("/orders/{orderId}", { params: { path: { orderId } }, headers: bearer(token) }),
  );

export const getMyWallet = (token: string) =>
  unwrap(creditApi.GET("/wallets/me", { headers: bearer(token) }));
