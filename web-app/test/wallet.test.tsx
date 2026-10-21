import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import { Suspense } from "react";
import type { LedgerItem, Receipt } from "../src/lib/order-api";

const window = new Window({ url: "http://localhost:3000/wallet" });
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const auth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call("test-token"),
  user: { id: "me" },
};
mock.module("../src/lib/auth", () => ({ useAuth: () => auth }));
mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {}, back: () => {} }) }));
mock.module("../src/components/ResponsiveShell", () => ({
  ResponsiveShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const { default: WalletPage } = await import("../src/app/(app)/wallet/page");
const { default: ReceiptPage } = await import("../src/app/(app)/request/[id]/receipt/page");
const { CreditsProvider } = await import("../src/lib/credits");

const ORDER = "11111111-0000-4000-8000-000000000001";
const PAYMENT = "33333333-0000-4000-8000-000000000001";

let n = 0;
const entry = (type: LedgerItem["type"], totalChange: number, changes: Partial<LedgerItem> = {}): LedgerItem => ({
  transactionId: `22222222-0000-4000-8000-${String(n++).padStart(12, "0")}`,
  type,
  amount: Math.abs(totalChange) || 2,
  orderId: type === "ISSUE" ? null : ORDER,
  occurredAt: "2026-10-20T08:00:00Z",
  resultingAvailable: 3,
  resultingReserved: 0,
  resultingTotal: 7,
  totalChange,
  ...changes,
});

const receipt: Receipt = {
  orderId: ORDER,
  requesterId: "me",
  courierId: "them",
  supplier: {
    supplierId: "00000000-0000-4000-8000-000000000001",
    name: "Kopi Corner",
    type: "CAFE",
    building: "COM2",
    floor: "1",
    locationDescription: "By the stairs",
  },
  reward: 3,
  creditTransactionId: PAYMENT,
  timestamps: {
    createdAt: "2026-10-20T08:00:00Z",
    acceptedAt: "2026-10-20T08:05:00Z",
    pickedUpAt: "2026-10-20T08:15:00Z",
    deliveredAt: null,
    completionRequestedAt: "2026-10-20T09:00:00Z",
    completedAt: "2026-10-20T09:00:02Z",
  },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Pages = Record<string, { items: LedgerItem[]; nextCursor: string | null }>;
const realFetch = globalThis.fetch;
let asked: URL[] = [];
function serve({
  wallet = { available: 3, reserved: 2, total: 5 },
  pages = { "": { items: [], nextCursor: null } } as Pages,
  receiptStatus = 200,
  receiptCode = "RECEIPT_NOT_FOUND",
} = {}) {
  globalThis.fetch = (async (request: Request) => {
    const url = new URL(request.url);
    asked.push(url);
    if (url.pathname === "/wallets/me") return json(200, { userId: "me", ...wallet });
    if (url.pathname === "/wallets/me/ledger") return json(200, pages[url.searchParams.get("cursor") ?? ""]);
    if (url.pathname.endsWith("/receipt"))
      return receiptStatus === 200
        ? json(200, receipt)
        : json(receiptStatus, { error: { code: receiptCode, message: "No receipt." } });
    return json(404, { error: { code: "NOT_FOUND", message: "Not found." } });
  }) as unknown as typeof fetch;
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  asked = [];
  window.history.replaceState(null, "", "/wallet");
  container = document.createElement("div") as unknown as HTMLElement;
  document.body.appendChild(container as never);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});
afterAll(() => {
  for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"])
    delete (globalThis as Record<string, unknown>)[key];
});

async function render(ui: React.ReactNode) {
  await act(async () =>
    root.render(
      <Suspense>
        <CreditsProvider>{ui}</CreditsProvider>
      </Suspense>,
    ),
  );
  for (let i = 0; i < 8; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const rows = () => [...container.querySelectorAll('[id^="tx-"]')];
const amounts = () => rows().map((r) => r.lastElementChild!.textContent);
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label);
const link = (label: string) => [...container.querySelectorAll("a")].find((a) => a.textContent === label);

describe("the wallet (WEB-03)", () => {
  it("shows available, reserved and total as separate figures", async () => {
    serve({ wallet: { available: 3, reserved: 2, total: 5 } });
    await render(<WalletPage />);

    const text = container.textContent!;
    expect(text).toContain("Available3credits");
    expect(text).toContain("Reserved for your errands2");
    expect(text).toContain("Total5");
    expect(text).not.toContain("Earned this week");
    expect(text).not.toContain("can't post");
    expect(asked.filter((url) => url.pathname === "/wallets/me")).toHaveLength(1);
  });

  it("explains that a student with nothing available can still earn as a courier", async () => {
    serve({ wallet: { available: 0, reserved: 5, total: 5 } });
    await render(<WalletPage />);

    expect(container.textContent).toContain(
      "With no credits available you can't post a request, but you can still earn credits as a courier.",
    );
    expect(link("Find errands to deliver")?.getAttribute("href")).toBe("/feed");
  });

  it("signs each entry's change to the total, and labels it by type and direction", async () => {
    const items = [
      entry("TRANSFER", 3),
      entry("TRANSFER", -3),
      entry("RELEASE", 0, { amount: 2 }),
      entry("RESERVE", 0, { amount: 2 }),
      entry("ISSUE", 5),
    ];
    serve({ pages: { "": { items, nextCursor: null } } });
    await render(<WalletPage />);

    expect(amounts()).toEqual(["+3", "-3", "0", "0", "+5"]);
    expect(rows().map((r) => r.querySelector("p")!.textContent)).toEqual([
      "Earned for a delivery",
      "Paid your courier",
      "2 credits released back to you",
      "2 credits reserved for your errand",
      "Starting credits",
    ]);
    expect(rows()[0]!.textContent).toContain("Total after: 7");
    expect(rows().map((r) => r.querySelector("a")?.getAttribute("href") ?? null)).toEqual([
      `/request/${ORDER}/receipt`,
      `/request/${ORDER}/receipt`,
      `/request/${ORDER}`,
      `/request/${ORDER}`,
      null,
    ]);
  });

  it("loads the next page on demand, then hides Load more once there is none", async () => {
    const first = [entry("RESERVE", 0)];
    const second = [entry("ISSUE", 5)];
    serve({
      pages: { "": { items: first, nextCursor: "c2" }, c2: { items: second, nextCursor: null } },
    });
    await render(<WalletPage />);
    expect(rows()).toHaveLength(1);

    await act(async () => button("Load more")!.click());
    await render(<WalletPage />);
    expect(asked.some((u) => u.searchParams.get("cursor") === "c2")).toBe(true);
    expect(rows().map((r) => r.id)).toEqual([...first, ...second].map((e) => `tx-${e.transactionId}`));
    expect(button("Load more")).toBeUndefined();
  });

  it("reads again when the connection comes back", async () => {
    serve();
    await render(<WalletPage />);
    const before = asked.length;
    await act(async () => window.dispatchEvent(new window.Event("online")));
    await render(<WalletPage />);
    expect(asked.length).toBeGreaterThan(before);
  });

  it("shows a failed refresh above the last loaded wallet and retries", async () => {
    serve({ pages: { "": { items: [entry("ISSUE", 5)], nextCursor: null } } });
    await render(<WalletPage />);
    const workingFetch = globalThis.fetch;
    globalThis.fetch = (async (request: Request) =>
      new URL(request.url).pathname === "/wallets/me/ledger"
        ? json(503, { error: { code: "UNAVAILABLE", message: "Please try again." } })
        : workingFetch(request)) as typeof fetch;

    await act(async () => window.dispatchEvent(new window.Event("online")));
    await render(<WalletPage />);
    expect(container.textContent).toContain("The figures below may be out of date.");
    expect(rows()).toHaveLength(1);

    globalThis.fetch = workingFetch;
    await act(async () => button("Try again")!.click());
    await render(<WalletPage />);
    expect(container.textContent).not.toContain("may be out of date");
  });

  it("discards a Load more page when a refresh replaces its cursor", async () => {
    const original = entry("RESERVE", 0);
    const replacement = entry("TRANSFER", 3);
    const oldNext = entry("ISSUE", 5);
    const pages: Pages = {
      "": { items: [original], nextCursor: "old-cursor" },
      "old-cursor": { items: [oldNext], nextCursor: null },
    };
    serve({ pages });
    await render(<WalletPage />);
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const workingFetch = globalThis.fetch;
    globalThis.fetch = (async (request: Request) =>
      new URL(request.url).searchParams.get("cursor") === "old-cursor"
        ? pending
        : workingFetch(request)) as typeof fetch;

    await act(async () => button("Load more")!.click());
    pages[""] = { items: [replacement], nextCursor: "new-cursor" };
    await act(async () => window.dispatchEvent(new window.Event("online")));
    await render(<WalletPage />);
    finish(json(200, { items: [oldNext], nextCursor: null }));
    await render(<WalletPage />);

    expect(rows().map((row) => row.id)).toEqual([`tx-${replacement.transactionId}`]);
    expect(button("Load more")).toBeDefined();
  });

  it("explains a wallet that has not been issued yet", async () => {
    serve();
    const workingFetch = globalThis.fetch;
    globalThis.fetch = (async (request: Request) =>
      new URL(request.url).pathname.startsWith("/wallets/me")
        ? json(404, { error: { code: "WALLET_NOT_FOUND", message: "Wallet not found." } })
        : workingFetch(request)) as typeof fetch;
    await render(<WalletPage />);
    expect(container.textContent).toContain("Your wallet is being set up");
    expect(button("Check again")).toBeDefined();
  });
});

describe("from a receipt to its ledger entry and back (WEB-03)", () => {
  it("shows the receipt's parties, times and a link to the payment in the wallet", async () => {
    serve();
    await render(<ReceiptPage params={Promise.resolve({ id: ORDER })} />);

    const text = container.textContent!;
    expect(text).toContain("Kopi Corner, COM2, floor 1");
    expect(text).toContain("3 credits");
    expect(text).toContain("RequesterYou");
    expect(text).toContain("CourierAnother student");
    expect(text).toContain("Not recorded: an administrator decided it for the courier");
    expect(link("See it in your wallet")?.getAttribute("href")).toBe(`/wallet?tx=${PAYMENT}`);
    expect(asked[0]!.pathname).toBe(`/orders/${ORDER}/receipt`);
  });

  it("says when there is no receipt yet, with the way back to the errand", async () => {
    serve({ receiptStatus: 404 });
    await render(<ReceiptPage params={Promise.resolve({ id: ORDER })} />);
    expect(container.textContent).toContain("No receipt yet");
    expect(link("View errand")?.getAttribute("href")).toBe(`/request/${ORDER}`);
  });

  it("loads pages until the linked entry is found, focuses it, and links it back to the receipt", async () => {
    const payment = entry("TRANSFER", -3, { transactionId: PAYMENT });
    serve({
      pages: {
        "": { items: [entry("RESERVE", 0)], nextCursor: "c2" },
        c2: { items: [entry("RELEASE", 0)], nextCursor: "c3" },
        c3: { items: [payment], nextCursor: "c4" },
        c4: { items: [entry("ISSUE", 5)], nextCursor: null },
      },
    });
    window.history.replaceState(null, "", `/wallet?tx=${PAYMENT}`);
    await render(<WalletPage />);

    expect(asked.map((u) => u.searchParams.get("cursor")).filter(Boolean)).toEqual(["c2", "c3"]);
    const row = container.querySelector(`#tx-${PAYMENT}`)!;
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(row as never);
    expect(row.querySelector("a")?.getAttribute("href")).toBe(`/request/${ORDER}/receipt`);
    expect(button("Load more")).toBeDefined();

    await act(async () => window.dispatchEvent(new window.Event("online")));
    await render(<WalletPage />);
    expect(asked.map((u) => u.searchParams.get("cursor")).filter(Boolean)).toEqual(["c2", "c3"]);
  });

  it("says so when the linked entry is not in the wallet", async () => {
    serve({ pages: { "": { items: [entry("ISSUE", 5)], nextCursor: null } } });
    window.history.replaceState(null, "", `/wallet?tx=${PAYMENT}`);
    await render(<WalletPage />);
    expect(container.textContent).toContain("That entry isn't in your wallet's activity.");
  });

  it("finds the linked entry again if new activity pushes it past a refreshed first page", async () => {
    const payment = entry("TRANSFER", -3, { transactionId: PAYMENT });
    const pages: Pages = {
      "": { items: [entry("RESERVE", 0)], nextCursor: "old-next" },
      "old-next": { items: [payment], nextCursor: null },
    };
    serve({ pages });
    window.history.replaceState(null, "", `/wallet?tx=${PAYMENT}`);
    await render(<WalletPage />);

    pages[""] = { items: [entry("TRANSFER", 3)], nextCursor: "new-next" };
    pages["new-next"] = { items: [payment], nextCursor: null };
    await act(async () => window.dispatchEvent(new window.Event("online")));
    await render(<WalletPage />);

    expect(asked.some((url) => url.searchParams.get("cursor") === "new-next")).toBe(true);
    expect(container.querySelector(`#tx-${PAYMENT}`)?.getAttribute("aria-current")).toBe("true");
  });

  it("does not call an unknown order a receipt that is still pending", async () => {
    serve({ receiptStatus: 404, receiptCode: "ORDER_NOT_FOUND" });
    await render(<ReceiptPage params={Promise.resolve({ id: ORDER })} />);
    expect(container.textContent).toContain("Could not load this receipt");
    expect(container.textContent).not.toContain("No receipt yet");
  });
});
