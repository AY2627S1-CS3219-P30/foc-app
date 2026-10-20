import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act, Suspense } = await import("react");
const { createRoot } = await import("react-dom/client");

const auth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call("admin-token"),
  user: { id: "admin-1", roles: ["ADMIN"] },
};
mock.module("../src/lib/auth", () => ({ useAuth: () => auth }));
mock.module("../src/components/DesktopShell", () => ({
  DesktopShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
// The actions are tested on their own; here one button stands in for any action that changed the account.
mock.module("../src/app/(app)/admin/users/[userId]/AccountActions", () => ({
  AccountActions: ({ onDone }: { onDone: (message: string) => void }) => (
    <button type="button" onClick={() => onDone("Account suspended.")}>
      Act
    </button>
  ),
}));
const { DirectoryProvider } = await import("../src/app/(app)/admin/_components/Directory");
const { default: AccountPage } = await import("../src/app/(app)/admin/users/[userId]/page");

const ACCOUNT = "0198a1c2-5b3e-7c11-9d4a-2f8b6e1a7c30";
const user = {
  id: ACCOUNT,
  email: "alex@u.nus.edu",
  roles: ["STUDENT"],
  status: "ACTIVE",
  isSeededAdmin: false,
  profile: { displayName: "Alex Tan", contactPreference: "IN_APP", preferredMode: "REQUESTER" },
  createdAt: "2026-10-01T08:00:00Z",
  activatedAt: "2026-10-01T08:05:00Z",
};
const errand = {
  orderId: "0198a1c2-0000-7000-8000-00000000e001",
  supplier: { supplierId: "2c6eb5e4-037e-525a-bebe-063fe1fcabe4", name: "Cafe+ Robot Cafe", type: "FOOD", building: "Central Library", floor: "1", locationDescription: "Entrance" },
  items: [{ name: "Iced latte", quantity: 1 }],
  deliveryZone: "COM2",
  reward: 3,
  status: "OPEN",
  version: 2,
  acceptanceDeadlineAt: null,
  createdAt: "2026-10-20T08:00:00Z",
  updatedAt: "2026-10-20T08:00:05Z",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const down = () => json(503, { error: { code: "UNAVAILABLE", message: "Try again shortly." } });
const empty = { page: 1, pageSize: 10, total: 0, items: [] };

/** One fake for both services: the User Service on :3001, the Order Service on :3003. */
function serve({ users = true, orders = true } = {}) {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request);
    const url = new URL(request.url);
    if (url.port === "3003") {
      if (!orders) return down();
      return json(200, url.searchParams.has("requesterId") ? { ...empty, total: 1, items: [errand] } : empty);
    }
    if (url.pathname === `/admin/users/${ACCOUNT}`) return users ? json(200, user) : down();
    return json(200, { ...empty, pageSize: 100 });
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;
let seen: Request[] = [];
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
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
async function render() {
  const params = Promise.resolve({ userId: ACCOUNT });
  await act(async () =>
    root.render(
      <DirectoryProvider>
        <Suspense fallback={null}>
          <AccountPage params={params} />
        </Suspense>
      </DirectoryProvider>,
    ),
  );
  await settle();
}
const section = (heading: string) =>
  [...container.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === heading);
const errandCalls = () => seen.filter((r) => new URL(r.url).port === "3003").length;

describe("the account page and its errands (ADM-05)", () => {
  it("still lists the account's errands when the User Service does not answer", async () => {
    serve({ users: false });
    await render();

    expect(container.textContent).toContain("Couldn't open this account");
    expect(section("Errands they requested")?.textContent).toContain("Cafe+ Robot Cafe");
  });

  it("keeps the account, its actions and its audit trail when the Order Service does not answer", async () => {
    serve({ orders: false });
    await render();

    expect(container.textContent).toContain("alex@u.nus.edu");
    expect(section("Audit trail for this account")).toBeDefined();
    for (const heading of ["Errands they requested", "Errands they hold as courier"]) {
      const list = section(heading)!;
      expect(list.textContent).toContain("Couldn't load errands");
      expect([...list.querySelectorAll("button")].some((b) => b.textContent?.includes("Try again"))).toBe(true);
    }
  });

  it("loads the errands again after an action on the account, which can cancel or reopen them", async () => {
    serve();
    await render();
    const before = errandCalls();

    const act_ = [...container.querySelectorAll("button")].find((b) => b.textContent === "Act")!;
    await act(async () => act_.click());
    await settle();

    expect(errandCalls() - before).toBe(2);
  });
});
