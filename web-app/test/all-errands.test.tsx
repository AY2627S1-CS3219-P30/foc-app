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
    expect(asked.searchParams.get("page")).toBe("1");

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
    expect(seen.at(-1)!.searchParams.get("page")).toBe("1");
  });

  it("pages through the list", async () => {
    serve((url) =>
      json(200, {
        page: Number(url.searchParams.get("page")),
        pageSize: 20,
        total: 25,
        items: [errand(Number(url.searchParams.get("page")), "OPEN")],
      }),
    );
    await render(<AllErrands />);

    const next = [...container.querySelectorAll("button")].find((b) => /next/i.test(b.textContent ?? ""));
    await act(async () => (next as unknown as HTMLButtonElement).click());
    await settle();

    expect(seen.at(-1)!.searchParams.get("page")).toBe("2");
    expect(rows()[0]).toContain("Supplier 2");
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
  it("counts every disputed errand and links to the errands page", async () => {
    serve(() => json(200, { page: 1, pageSize: 1, total: 3, items: [errand(1, "DISPUTED")] }));
    await render(<DisputesWaitingStat />);

    expect(seen[0].searchParams.get("status")).toBe("DISPUTED");
    expect(seen[0].searchParams.get("pageSize")).toBe("1");
    const stat = container.querySelector("a") as unknown as HTMLAnchorElement;
    expect(stat.getAttribute("href")).toBe("/admin/errands");
    expect(stat.textContent).toContain("Disputes waiting");
    expect(stat.textContent).toContain("3");
  });

  it("shows a dash, not zero, when the Order Service does not answer", async () => {
    serve(() => json(503, { error: { code: "UNAVAILABLE", message: "Try again shortly." } }));
    await render(<DisputesWaitingStat />);

    expect(container.querySelector("a")?.textContent).toContain("—");
  });
});
