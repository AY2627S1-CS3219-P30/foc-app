import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const auth = { authed: <T,>(call: (token: string) => Promise<T>) => call("admin-token") };
mock.module("../src/lib/auth", () => ({ useAuth: () => auth }));
const { AllErrands } = await import("../src/app/(app)/admin/errands/AllErrands");
const { DisputesWaitingStat } = await import("../src/app/(app)/admin/errands/Disputes");

const errand = (n: number, status: string) => ({
  orderId: `0198a1c2-0000-7000-8000-00000000e00${n}`,
  supplier: {
    supplierId: "2c6eb5e4-037e-525a-bebe-063fe1fcabe4",
    name: `Supplier ${n}`,
    type: "FOOD",
    building: "Central Library",
    floor: "1",
    locationDescription: "Beside the entrance",
  },
  items: [{ name: "Iced latte", quantity: 1 }],
  deliveryZone: "COM2 level 1",
  reward: n,
  status,
  version: 2,
  createdAt: "2026-10-20T08:00:00Z",
  updatedAt: "2026-10-20T08:00:05Z",
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
let seen: URL[] = [];
function serve(respond: (url: URL) => Response) {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    seen.push(url);
    return respond(url);
  }) as typeof fetch;
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  seen = [];
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

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};

async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
  await settle();
}

async function choose(value: string) {
  const select = container.querySelector("select") as unknown as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  });
  await settle();
}

const rows = () => [...container.querySelectorAll("tbody tr")].map((tr) => tr.textContent ?? "");
async function click(text: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`No "${text}" button`);
  await act(async () => (found as unknown as HTMLButtonElement).click());
  await settle();
}
const befores = () => seen.map((url) => url.searchParams.get("before"));
/** A first page of 21 errands showing `shown`, and whatever `after` answers for a later one. */
const pages = (shown: ReturnType<typeof errand>[], after: () => Response) => (url: URL) =>
  url.searchParams.has("before") ? after() : json(200, { page: 1, pageSize: 20, total: 21, items: shown });

describe("every errand in the console (ADM-06)", () => {
  it("lists every errand from the Order Service, newest first, with its status and trace", async () => {
    serve(() =>
      json(200, { page: 1, pageSize: 20, total: 2, items: [errand(1, "DISPUTED"), errand(2, "COMPLETED")] }),
    );
    await render(<AllErrands />);

    const asked = seen[0];
    expect(`${asked.origin}${asked.pathname}`.endsWith("/admin/orders")).toBe(true);
    expect(asked.searchParams.get("status")).toBeNull();
    expect(asked.searchParams.get("requesterId")).toBeNull();
    expect(asked.searchParams.get("before")).toBeNull();

    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain("Disputed");
    expect(rows()[0]).toContain("Supplier 1");
    expect(rows()[1]).toContain("Completed");
    const trace = container.querySelector("tbody a") as unknown as HTMLAnchorElement;
    expect(trace.getAttribute("href")).toContain(errand(1, "DISPUTED").orderId);
  });

  it("narrows to live errands, finished ones, or one status, from the first page", async () => {
    serve(() => json(200, { page: 1, pageSize: 20, total: 0, items: [] }));
    await render(<AllErrands />);

    await choose("live");
    const live = seen.at(-1)!.searchParams.get("status")!.split(",");
    expect(live).toContain("OPEN");
    expect(live).toContain("DISPUTED");
    expect(live).not.toContain("COMPLETED");

    await choose("finished");
    expect(seen.at(-1)!.searchParams.get("status")!.split(",").sort()).toEqual([
      "CANCELLED",
      "COMPLETED",
      "EXPIRED",
      "REJECTED",
    ]);

    await choose("DISPUTED");
    expect(seen.at(-1)!.searchParams.get("status")).toBe("DISPUTED");
    expect(seen.at(-1)!.searchParams.get("before")).toBeNull();
  });

  it("pages on from the last errand shown, not by position, and back", async () => {
    serve(
      pages([errand(1, "OPEN"), errand(2, "OPEN")], () =>
        json(200, { page: 1, pageSize: 20, total: 1, items: [errand(3, "OPEN")] }),
      ),
    );
    await render(<AllErrands />);
    expect(container.textContent).toContain("Page 1 of 2");

    await click("Next");
    expect(seen.at(-1)!.searchParams.get("before")).toBe(errand(2, "OPEN").orderId);
    expect(seen.at(-1)!.searchParams.get("page")).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("Supplier 3");
    expect(container.textContent).toContain("Page 2 of 2");

    await click("Previous");
    expect(seen.at(-1)!.searchParams.get("before")).toBeNull();
    expect(rows()[0]).toContain("Supplier 1");
    expect(container.textContent).toContain("Page 1 of 2");
  });

  it("steps back a page when every errand after the last one shown has left the list", async () => {
    serve(pages([errand(1, "OPEN")], () => json(200, { page: 1, pageSize: 20, total: 0, items: [] })));
    await render(<AllErrands />);
    await click("Next");

    expect(befores()).toEqual([null, errand(1, "OPEN").orderId, null]);
    expect(rows()[0]).toContain("Supplier 1");
    expect(container.textContent).not.toContain("No errands");
  });

  it("starts again from the newest when the filter changes, and Refresh keeps the page", async () => {
    serve(pages([errand(1, "OPEN")], () => json(200, { page: 1, pageSize: 20, total: 1, items: [errand(2, "OPEN")] })));
    await render(<AllErrands />);
    await click("Next");
    await click("Refresh");
    expect(befores().slice(1)).toEqual([errand(1, "OPEN").orderId, errand(1, "OPEN").orderId]);

    await choose("DISPUTED");
    expect(seen.at(-1)!.searchParams.get("before")).toBeNull();
    expect(seen.at(-1)!.searchParams.get("status")).toBe("DISPUTED");
  });

  it("says so when the Order Service does not answer, and offers to try again", async () => {
    serve(() => json(503, { error: { code: "UNAVAILABLE", message: "Try again shortly." } }));
    await render(<AllErrands />);

    expect(container.textContent).toContain("Couldn't load errands");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Try again"))).toBe(
      true,
    );
  });
});

describe("the overview's count of disputes waiting (ADM-06)", () => {
  it("counts the disputes the errands page lists for this administrator, and links there", async () => {
    // Referred to this administrator, or to no one yet; one referred elsewhere is not listed.
    serve(() => json(200, { items: [errand(1, "DISPUTED"), errand(2, "DISPUTED")] }));
    await render(<DisputesWaitingStat />);

    expect(seen[0].pathname.endsWith("/admin/orders/referred")).toBe(true);
    const stat = container.querySelector("a") as unknown as HTMLAnchorElement;
    expect(stat.getAttribute("href")).toBe("/admin/errands");
    expect(stat.textContent).toContain("Disputes waiting");
    expect(stat.textContent).toContain("2");
  });

  it("shows a dash, not zero, when the Order Service does not answer", async () => {
    serve(() => json(503, { error: { code: "UNAVAILABLE", message: "Try again shortly." } }));
    await render(<DisputesWaitingStat />);

    expect(container.querySelector("a")?.textContent).toContain("—");
  });
});
