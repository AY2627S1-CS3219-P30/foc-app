import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import type { MyOrder } from "../src/lib/order-api";
import { isFinal } from "../src/lib/order-status";

const window = new Window({ url: "http://localhost:3000/order-history" });
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const auth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call("test-token"),
  user: { id: "me", profile: { preferredMode: "REQUESTER" as "REQUESTER" | "COURIER" } },
};
mock.module("../src/lib/auth", () => ({ useAuth: () => auth }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
mock.module("../src/components/DesktopShell", () => ({
  DesktopShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const { default: OrderHistoryPage } = await import("../src/app/(app)/order-history/page");
const { StoreProvider } = await import("../src/lib/store");

const at = "2026-10-20T08:00:00Z";
const errand = (orderId: string, status: MyOrder["status"], changes: Partial<MyOrder> = {}): MyOrder => ({
  orderId,
  supplier: {
    supplierId: "00000000-0000-4000-8000-000000000001",
    name: `Supplier ${orderId}`,
    type: "CAFE",
    building: "COM2",
    floor: "1",
    locationDescription: "By the stairs",
  },
  items: [{ name: "Kopi O", quantity: 1 }],
  deliveryZone: "PGP House 7",
  reward: 3,
  status,
  version: 1,
  acceptanceDeadlineAt: "2026-10-20T09:00:00Z",
  createdAt: at,
  updatedAt: at,
  serverTime: at,
  myRole: "REQUESTER",
  ...changes,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
let reads = 0;
let requested: string[] = [];
/** Delays of a second or more that the page asked for. They never fire: the test reads on demand. */
let scheduled: number[] = [];

function serve(items: MyOrder[], truncated = false) {
  globalThis.fetch = (async (request: Request) => {
    reads++;
    requested.push(request.url);
    const query = new URL(request.url).searchParams;
    const role = query.get("role");
    const active = query.get("active");
    return json({
      items: items.filter((order) => {
        const matchesRole = !role || order.myRole === role;
        const matchesActive = active === null || (active === "true") === !isFinal(order.status);
        return matchesRole && matchesActive;
      }),
      truncated,
      nextCursor: truncated ? "older" : null,
    });
  }) as unknown as typeof fetch;
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  auth.user.profile.preferredMode = "REQUESTER";
  reads = 0;
  requested = [];
  scheduled = [];
  globalThis.setTimeout = ((run: () => void, ms = 0) => {
    if (ms < 1000) return realSetTimeout(run, ms);
    scheduled.push(ms);
    return 0;
  }) as typeof setTimeout;
  container = document.createElement("div") as unknown as HTMLElement;
  document.body.appendChild(container as never);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});
afterAll(() => {
  for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"])
    delete (globalThis as Record<string, unknown>)[key];
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => realSetTimeout(r, 0)));
};

async function render() {
  await act(async () =>
    root.render(
      <StoreProvider>
        <OrderHistoryPage />
      </StoreProvider>,
    ),
  );
  await settle();
}

/** The page renders a phone and a desktop tree; the first is enough. */
const section = (title: string) =>
  [...container.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === title);

describe("order history (WEB-03)", () => {
  it("splits active from past, with each errand's status, explanation, role and times", async () => {
    serve([
      errand("open", "OPEN"),
      errand("expiring", "RELEASE_PENDING_CREDIT", { releaseReason: "EXPIRED" }),
      errand("done", "COMPLETED", { updatedAt: "2026-10-20T10:00:00Z" }),
      errand("cancelled", "CANCELLED"),
    ]);
    await render();

    const active = section("Active")!.textContent!;
    expect(active).toContain("Supplier open");
    expect(active).toContain("The reward is reserved. The request is waiting for a courier to accept it.");
    expect(active).toContain("You requested");
    expect(active).toContain("Posted");
    expect(active).toContain("open until");
    expect(active).toContain("Expiring");
    expect(active).toContain("No courier kept the errand before its deadline, so it is expiring.");
    expect(active).not.toContain("Supplier done");

    const past = section("Past")!.textContent!;
    expect(past).toContain("Supplier done");
    expect(past).toContain("You requested");
    expect(past).toContain("The reward has been transferred to the courier.");
    expect(past).toContain("ended");
    expect(past).toContain("Supplier cancelled");
    expect(past).not.toContain("Supplier open");
  });

  it("keeps active own requests visible in courier mode", async () => {
    serve([
      errand("mine", "DELIVERED"),
      errand("past-request", "COMPLETED"),
      errand("delivery", "ACCEPTED", { myRole: "COURIER" }),
    ]);
    await render();
    expect(container.textContent).toContain("Supplier mine");
    expect(container.textContent).not.toContain("Supplier delivery");
    expect(requested.some((url) => url.includes("/orders/mine?role=REQUESTER"))).toBe(true);

    auth.user.profile.preferredMode = "COURIER";
    await act(async () => root.render(<StoreProvider><OrderHistoryPage /></StoreProvider>));
    await settle();
    expect(container.textContent).toContain("Supplier delivery");
    expect(section("Requests you placed")?.textContent).toContain("Supplier mine");
    expect(section("Active deliveries")?.textContent).toContain("Supplier delivery");
    expect(container.textContent).not.toContain("Supplier past-request");
    expect(requested.some((url) => url.includes("/orders/mine?role=COURIER"))).toBe(true);
    expect(requested.some((url) => url.includes("/orders/mine?role=REQUESTER&active=true"))).toBe(true);
  });

  it("links to the receipt from completed errands only", async () => {
    serve([errand("open", "OPEN"), errand("done", "COMPLETED"), errand("cancelled", "CANCELLED")]);
    await render();

    const receipts = [...section("Past")!.querySelectorAll("a")].filter((a) => a.textContent === "View receipt");
    expect(receipts.map((a) => a.getAttribute("href"))).toEqual(["/request/done/receipt"]);
    expect(section("Active")!.textContent).not.toContain("View receipt");
  });

  it("loads another page and keeps it through refreshes, without repeating an updated errand", async () => {
    let first = [errand("done", "COMPLETED")];
    globalThis.fetch = (async (request: Request) => {
      const cursor = new URL(request.url).searchParams.get("cursor");
      return json(cursor
        ? { items: [errand("older", "COMPLETED"), errand("done", "COMPLETED")], nextCursor: null, truncated: false }
        : { items: first, nextCursor: "older", truncated: true });
    }) as typeof fetch;
    await render();
    const loadMore = [...container.querySelectorAll("button")].find((button) => button.textContent === "Load more errands")!;
    expect(loadMore).toBeTruthy();
    await act(async () => loadMore.click());
    await settle();
    expect(section("Past")?.textContent).toContain("Supplier older");
    expect(section("Past")?.textContent?.match(/Supplier done/g)).toHaveLength(1);

    first = [errand("new", "COMPLETED"), errand("done", "COMPLETED", { version: 2 })];
    await act(async () => window.dispatchEvent(new window.Event("online")));
    await settle();
    expect(section("Past")?.textContent).toContain("Supplier older");
    expect(section("Past")?.textContent).toContain("Supplier new");
    expect(section("Past")?.textContent?.match(/Supplier done/g)).toHaveLength(1);

    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { code: "UNAVAILABLE", message: "Try later." },
    }), { status: 503, headers: { "content-type": "application/json" } })) as typeof fetch;
    await act(async () => window.dispatchEvent(new window.Event("online")));
    await settle();
    expect(section("Past")?.textContent).toContain("Supplier older");
    expect(container.textContent).toContain("Could not refresh your errands");
  });

  it("reads again when the connection comes back", async () => {
    serve([errand("done", "COMPLETED")]);
    await render();
    expect(reads).toBe(1);

    await act(async () => window.dispatchEvent(new window.Event("online")));
    await settle();
    expect(reads).toBe(2);
  });

  it("shows a failed refresh with a retry while keeping the last history", async () => {
    serve([errand("done", "COMPLETED")]);
    await render();
    const workingFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "Try later." } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await act(async () => window.dispatchEvent(new window.Event("online")));
    await settle();
    expect(container.textContent).toContain("Could not refresh your errands");
    expect(section("Past")?.textContent).toContain("Supplier done");

    globalThis.fetch = workingFetch;
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => retry.click());
    await settle();
    expect(container.textContent).not.toContain("Could not refresh your errands");
  });

  it("polls quickly while credits move, slowly while errands are active, and not once all are past", async () => {
    serve([errand("pending", "COMPLETION_PENDING_CREDIT"), errand("open", "OPEN")]);
    await render();
    expect(scheduled).toEqual([5_000]);
    await act(async () => root.unmount());

    root = createRoot(container);
    serve([errand("open", "OPEN")]);
    await render();
    expect(scheduled).toEqual([5_000, 30_000]);
    await act(async () => root.unmount());

    root = createRoot(container);
    serve([errand("done", "COMPLETED")]);
    await render();
    expect(scheduled).toEqual([5_000, 30_000]);
  });
});
