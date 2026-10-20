import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const auth = { authed: <T,>(call: (token: string) => Promise<T>) => call("admin-token") };
mock.module("../src/lib/auth", () => ({ useAuth: () => auth }));
const { AccountErrands } = await import("../src/app/(app)/admin/users/[userId]/AccountErrands");

const ACCOUNT = "0198a1c2-5b3e-7c11-9d4a-2f8b6e1a7c30";
const ERRAND = "0198a1c2-0000-7000-8000-00000000e001";

const errand = {
  orderId: ERRAND,
  supplier: {
    supplierId: "2c6eb5e4-037e-525a-bebe-063fe1fcabe4",
    name: "Cafe+ Robot Cafe",
    type: "FOOD",
    building: "Central Library",
    floor: "1",
    locationDescription: "Beside the entrance",
  },
  items: [{ name: "Iced latte", quantity: 1 }],
  deliveryZone: "COM2 level 1",
  reward: 3,
  status: "OPEN",
  version: 2,
  acceptanceDeadlineAt: "2026-10-20T09:00:00Z",
  createdAt: "2026-10-20T08:00:00Z",
  updatedAt: "2026-10-20T08:00:05Z",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
let seen: Request[] = [];
function serve(respond: (url: URL) => Response) {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request);
    return respond(new URL(request.url));
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

async function render() {
  await act(async () => root.render(<AccountErrands userId={ACCOUNT} />));
  // Let both loads settle.
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const section = (heading: string) =>
  [...container.querySelectorAll("section")].find((s) => s.querySelector("h2, h3")?.textContent === heading);

describe("an account's errands on its page (ADM-05)", () => {
  it("lists what the account requested and what it holds as courier, each from the Order Service", async () => {
    serve((url) =>
      json(200, {
        page: 1,
        pageSize: 10,
        total: url.searchParams.has("requesterId") ? 1 : 0,
        items: url.searchParams.has("requesterId") ? [errand] : [],
      }),
    );
    await render();

    const asked = seen.map((r) => new URL(r.url));
    expect(asked.map((u) => `${u.pathname}?${u.searchParams.toString()}`).sort()).toEqual([
      `/admin/orders?courierId=${ACCOUNT}&page=1&pageSize=10`,
      `/admin/orders?requesterId=${ACCOUNT}&page=1&pageSize=10`,
    ]);
    expect(seen.every((r) => r.headers.get("authorization") === "Bearer admin-token")).toBe(true);

    const requested = section("Errands they requested");
    expect(requested?.textContent).toContain("Cafe+ Robot Cafe");
    expect(requested?.textContent).toContain("Open");
    const trace = requested?.querySelector(`a[href="/admin/operations?order=${ERRAND}#trace"]`);
    expect(trace).not.toBeNull();

    expect(section("Errands they hold as courier")?.textContent).toContain("No errands as courier");
  });

  it("keeps the rest of the page when the Order Service does not answer", async () => {
    serve(() => json(503, { error: { code: "UNAVAILABLE", message: "Try again shortly." } }));
    await render();

    expect(section("Errands they requested")?.textContent).toContain("Couldn't load");
    expect(section("Errands they requested")?.querySelector("button")?.textContent).toContain("Try again");
  });
});
