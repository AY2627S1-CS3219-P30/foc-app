import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom's <dialog> has no modal mode; opening it is all the reason dialog needs here.
const dialogProto = (window as unknown as { HTMLDialogElement: { prototype: Record<string, unknown> } })
  .HTMLDialogElement.prototype;
dialogProto.showModal = function (this: HTMLElement) {
  this.setAttribute("open", "");
};
dialogProto.close = function (this: HTMLElement) {
  this.removeAttribute("open");
};
const { act, Suspense } = await import("react");
const { createRoot } = await import("react-dom/client");

const ME = "0198a1c2-aaaa-7000-8000-00000000a001";
const auth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call("admin-token"),
  user: { id: ME, roles: ["ADMIN"] },
};
mock.module("../src/lib/auth", () => ({ useAuth: () => auth }));
mock.module("../src/components/DesktopShell", () => ({
  DesktopShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const { DirectoryProvider } = await import("../src/app/(app)/admin/_components/Directory");
const { default: ErrandsPage } = await import("../src/app/(app)/admin/errands/page");
const { default: DisputePage } = await import("../src/app/(app)/admin/errands/[orderId]/page");

const MINE = "0198a1c2-0000-7000-8000-00000000d001";
const UNREFERRED = "0198a1c2-0000-7000-8000-00000000d002";
const REQUESTER = "0198a1c2-bbbb-7000-8000-00000000b001";
const COURIER = "0198a1c2-cccc-7000-8000-00000000c001";

const base = {
  supplier: { supplierId: "2c6eb5e4-037e-525a-bebe-063fe1fcabe4", name: "Cafe+ Robot Cafe", type: "FOOD", building: "Central Library", floor: "1", locationDescription: "Entrance" },
  deliveryZone: "COM2 level 1",
  reward: 3,
  status: "DISPUTED",
  version: 6,
  acceptanceDeadlineAt: null,
  createdAt: "2026-10-22T08:00:00Z",
  updatedAt: "2026-10-22T09:00:00Z",
  serverTime: "2026-10-22T09:05:00Z",
};
/** The private view the referred administrator is given. */
const privateErrand = {
  ...base,
  orderId: MINE,
  items: [{ name: "Iced latte", quantity: 2, note: "Less ice" }],
  requesterId: REQUESTER,
  courierId: COURIER,
  deliveryInstructions: "Leave it at the lobby counter",
};
const referred = {
  items: [
    { ...privateErrand, referredBy: "REPORT_NON_RECEIPT", assignedToMe: true },
    { ...base, orderId: UNREFERRED, items: [{ name: "Printout", quantity: 1 }], referredBy: "DELIVERY_PERIOD_PASSED", assignedToMe: false },
  ],
};
const decisions = {
  items: [{ orderId: "0198a1c2-0000-7000-8000-00000000d009", adminId: ME, outcome: "REQUESTER", reason: "No proof of delivery", decidedAt: "2026-10-21T10:00:00Z" }],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = { page: 1, pageSize: 100, total: 0, items: [] };

let seen: Request[] = [];
/** One fake for the User Service (:3001) and the Order Service (:3003). */
function serve(order: (url: URL, request: Request) => Response | undefined = () => undefined) {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request);
    const url = new URL(request.url);
    if (url.port === "3003") {
      const answer = order(url, request);
      if (answer) return answer;
      if (url.pathname === "/admin/orders/referred") return json(200, referred);
      if (url.pathname === "/admin/orders/decisions") return json(200, decisions);
      if (url.pathname === `/orders/${MINE}`) return json(200, privateErrand);
      return json(200, { items: [] });
    }
    return json(200, empty);
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;
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
async function render(node: ReactNode) {
  await act(async () =>
    root.render(
      <DirectoryProvider>
        <Suspense fallback={null}>{node}</Suspense>
      </DirectoryProvider>,
    ),
  );
  await settle();
}
const section = (heading: string) =>
  [...container.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === heading);
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text);

describe("the disputes on the Errands page (#271)", () => {
  it("lists the disputes referred to me, which open, and those referred to no one yet", async () => {
    serve();
    await render(<ErrandsPage />);

    const disputes = section("Disputes")!;
    expect(disputes).toBeDefined();
    const rows = [...disputes.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("The requester reported it never arrived");
    expect(rows[0].textContent).toContain("You");
    expect(rows[0].querySelector(`a[href="/admin/errands/${MINE}"]`)).not.toBeNull();
    expect(rows[1].textContent).toContain("The delivery period passed");
    expect(rows[1].textContent).toContain("No one yet");
    expect(rows[1].querySelector(`a[href="/admin/errands/${UNREFERRED}"]`)).toBeNull();
  });

  it("lists the latest decisions with their outcome and reason", async () => {
    serve();
    await render(<ErrandsPage />);

    const recent = section("Recent decisions")!.textContent;
    expect(recent).toContain("For the requester");
    expect(recent).toContain("No proof of delivery");
  });
});

describe("one dispute, opened by an administrator (#271)", () => {
  const open = (orderId: string) => render(<DisputePage params={Promise.resolve({ orderId })} />);

  it("shows the referred administrator its private details and why it was disputed", async () => {
    serve();
    await open(MINE);

    expect(seen.some((r) => r.url.endsWith(`/orders/${MINE}?view=private`))).toBe(true);
    const text = container.textContent!;
    expect(text).toContain("Leave it at the lobby counter");
    expect(text).toContain("2 × Iced latte");
    expect(text).toContain("Less ice");
    expect(text).toContain("The requester reported it never arrived");
    expect(container.querySelector(`a[href="/admin/users/${REQUESTER}"]`)).not.toBeNull();
    expect(container.querySelector(`a[href="/admin/users/${COURIER}"]`)).not.toBeNull();
  });

  it("records a decision with a reason, at the version it was read", async () => {
    let decided: unknown;
    serve((url, request) => {
      if (url.pathname === `/admin/orders/${MINE}/resolve`) {
        decided = request.clone().json();
        return json(200, { ...privateErrand, status: "COMPLETION_PENDING_CREDIT", version: 7 });
      }
    });
    await open(MINE);

    await act(async () => button("Decide for the courier")!.click());
    const reason = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(reason, "The handover photo shows the right counter");
      reason.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => (container.querySelector("dialog form") as HTMLFormElement).requestSubmit());
    await settle();

    expect(await decided).toEqual({
      outcome: "COURIER",
      reason: "The handover photo shows the right counter",
      expectedVersion: 6,
    });
    expect(container.textContent).toContain("Decided for the courier");
  });

  it("shows another administrator no private details and no way to decide", async () => {
    serve((url) => {
      if (url.pathname === `/orders/${MINE}`)
        return json(403, { error: { code: "PRIVATE_FORBIDDEN", message: "Not yours to read." } });
    });
    await open(MINE);

    const text = container.textContent!;
    expect(text).toContain("referred to another administrator");
    expect(text).not.toContain("Leave it at the lobby counter");
    expect(button("Decide for the courier")).toBeUndefined();
    expect(button("Decide for the requester")).toBeUndefined();
  });
});
