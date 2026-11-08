// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-20 to 2026-11-03
// Scope: Generated the initial implementation for "request composer on the Order API" (WEB-01,
//   WEB-04, WEB-02); later new features.
// Author review: Patrick Thomas and Zhang Yuan reviewed the implementation for correctness, ran it
//   against the test suite, and checked that it fits our service boundaries without fatal errors
//   before committing.

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
export type OpenOrder = components["schemas"]["OpenOrderSummary"];
export type MyOrder = components["schemas"]["MyOrders"]["items"][number];
export type Receipt = components["schemas"]["OrderReceipt"];
export type OrderHistory = components["schemas"]["OrderHistory"];
export type Wallet = CreditComponents["schemas"]["Wallet"];
export type LedgerItem = CreditComponents["schemas"]["LedgerItem"];

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

export const getOrder = (token: string, orderId: string, signal?: AbortSignal) =>
  unwrap(
    orderApi.GET("/orders/{orderId}", {
      params: { path: { orderId } },
      headers: bearer(token),
      signal,
    }),
  );

export const getMyWallet = (token: string, signal?: AbortSignal) =>
  unwrap(creditApi.GET("/wallets/me", { headers: bearer(token), signal }));

export const getReceipt = (token: string, orderId: string) =>
  unwrap(
    orderApi.GET("/orders/{orderId}/receipt", {
      params: { path: { orderId } },
      headers: bearer(token),
    }),
  );

/** The service authorizes and redacts this participant projection; the browser never reconstructs it. */
export const getOrderHistory = (token: string, orderId: string, signal?: AbortSignal) =>
  unwrap(
    orderApi.GET("/orders/{orderId}/history", {
      params: { path: { orderId } },
      headers: bearer(token),
      signal,
    }),
  );

export const listMyLedger = (token: string, cursor?: string) =>
  unwrap(creditApi.GET("/wallets/me/ledger", { params: { query: { cursor } }, headers: bearer(token) }));

export type OpenOrdersFilter = {
  pickupBuilding?: string;
  minReward?: number;
  cursor?: string;
  limit?: number;
};

export async function listOpenOrders(
  token: string,
  filter: OpenOrdersFilter = {},
  signal?: AbortSignal,
) {
  const call = orderApi.GET("/orders", {
    params: { query: filter },
    headers: bearer(token),
    signal,
  });
  const items = await unwrap(call);
  return { items, nextCursor: (await call).response.headers.get("Next-Cursor") };
}

export const listMyOrders = (
  token: string,
  filter: {
    role?: "REQUESTER" | "COURIER";
    active?: boolean;
    cursor?: string;
    limit?: number;
  } = {},
  signal?: AbortSignal,
) =>
  unwrap(orderApi.GET("/orders/mine", { params: { query: filter }, headers: bearer(token), signal }));

const COMMAND_PATHS = {
  accept: "/orders/{orderId}/accept",
  pickup: "/orders/{orderId}/pickup",
  deliver: "/orders/{orderId}/deliver",
  withdraw: "/orders/{orderId}/withdraw",
  cancel: "/orders/{orderId}/cancel",
  confirmReceipt: "/orders/{orderId}/confirm-receipt",
  reportNonDelivery: "/orders/{orderId}/report-non-delivery",
  reportNonReceipt: "/orders/{orderId}/report-non-receipt",
} as const;

export type Command = keyof typeof COMMAND_PATHS;

/**
 * Every command is sent with the version the caller last saw, so a stale view is refused with `409`,
 * and with its confirmation's key, so a retry of a send whose answer was lost gets that answer back.
 */
export const sendCommand = (
  token: string,
  command: Command,
  { orderId, version }: Pick<Order, "orderId" | "version">,
  idempotencyKey: string,
) =>
  unwrap(
    orderApi.POST(COMMAND_PATHS[command], {
      params: { path: { orderId }, header: { "Idempotency-Key": idempotencyKey } },
      body: { expectedVersion: version },
      headers: bearer(token),
    }),
  );
