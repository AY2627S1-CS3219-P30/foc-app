import { afterAll, expect, it } from "bun:test";
import {
  createOrder,
  getMyWallet,
  getOrder,
  getReceipt,
  listMyLedger,
  listMyOrders,
  listOpenOrders,
  sendCommand,
  type Command,
} from "../src/lib/order-api";

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const requests: Request[] = [];
let postStatus = 201;
globalThis.fetch = (async (request: Request) => {
  requests.push(request.clone());
  return new Response(JSON.stringify({ ok: true }), {
    status: request.method === "POST" ? postStatus : 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const body = {
  supplierId: "00000000-0000-4000-8000-000000000001",
  items: [{ name: "Kopi O", quantity: 1 }],
  deliveryZone: "PGP",
  deliveryInstructions: "Lobby",
  reward: 2,
};

it("creates an order with the idempotency key and bearer token", async () => {
  expect((await createOrder("access-token", body, "key-1")).replayed).toBe(false);
  const [request] = requests.splice(0);
  expect(request!.method).toBe("POST");
  expect(request!.url).toBe("http://localhost:3003/orders");
  expect(request!.headers.get("idempotency-key")).toBe("key-1");
  expect(request!.headers.get("authorization")).toBe("Bearer access-token");
  expect(await request!.json()).toEqual(body);
});

it("says when the key replayed an order it had already created", async () => {
  postStatus = 200;
  expect((await createOrder("access-token", body, "key-1")).replayed).toBe(true);
  postStatus = 201;
  requests.splice(0);
});

it("reads an order from the Order Service and the wallet from the Credit Service", async () => {
  await getOrder("access-token", "order-1");
  await getMyWallet("access-token");
  expect(requests.splice(0).map((r) => r.url)).toEqual([
    "http://localhost:3003/orders/order-1",
    "http://localhost:3004/wallets/me",
  ]);
});

it("lists open errands and the caller's own", async () => {
  await listOpenOrders("access-token");
  await listMyOrders("access-token");
  await listMyOrders("access-token", { role: "REQUESTER", active: true });
  expect(requests.splice(0).map((r) => r.url)).toEqual([
    "http://localhost:3003/orders",
    "http://localhost:3003/orders/mine",
    "http://localhost:3003/orders/mine?role=REQUESTER&active=true",
  ]);
});

it("sends paging and courier filters, and reads the open list cursor header", async () => {
  const normalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: Request) => {
    requests.push(request.clone());
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json", "Next-Cursor": "next-page" },
    });
  }) as typeof fetch;
  try {
    expect(await listOpenOrders("access-token", {
      pickupBuilding: "COM2", minReward: 4, cursor: "first-page", limit: 20,
    })).toEqual({ items: [], nextCursor: "next-page" });
    await listMyOrders("access-token", { role: "COURIER", cursor: "first-page", limit: 20 });
    expect(requests.splice(0).map((request) => request.url)).toEqual([
      "http://localhost:3003/orders?pickupBuilding=COM2&minReward=4&cursor=first-page&limit=20",
      "http://localhost:3003/orders/mine?role=COURIER&cursor=first-page&limit=20",
    ]);
  } finally {
    globalThis.fetch = normalFetch;
  }
});

it("reads a receipt from the Order Service and pages the ledger from the Credit Service", async () => {
  await getReceipt("access-token", "order-1");
  await listMyLedger("access-token");
  await listMyLedger("access-token", "c2");
  const sent = requests.splice(0);
  expect(sent.map((r) => r.url)).toEqual([
    "http://localhost:3003/orders/order-1/receipt",
    "http://localhost:3004/wallets/me/ledger",
    "http://localhost:3004/wallets/me/ledger?cursor=c2",
  ]);
  expect(sent.every((r) => r.headers.get("authorization") === "Bearer access-token")).toBe(true);
});

it("sends every command to its path with the version on screen", async () => {
  const paths: Record<Command, string> = {
    accept: "accept",
    pickup: "pickup",
    deliver: "deliver",
    withdraw: "withdraw",
    cancel: "cancel",
    confirmReceipt: "confirm-receipt",
    reportNonDelivery: "report-non-delivery",
    reportNonReceipt: "report-non-receipt",
  };
  for (const [command, path] of Object.entries(paths)) {
    await sendCommand("access-token", command as Command, { orderId: "order-1", version: 7 });
    const [request] = requests.splice(0);
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe(`http://localhost:3003/orders/order-1/${path}`);
    expect(await request!.json()).toEqual({ expectedVersion: 7 });
  }
});
