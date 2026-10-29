import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const auth = {
  user: { id: "first-participant" } as { id: string } | null,
  authed: <T,>(call: (token: string) => Promise<T>) => call("current-session"),
};
mock.module("../src/lib/auth", () => ({ useAuth: () => auth }));
const { useOrderHistory } = await import("../src/lib/use-order-history");

function Probe({ orderId = "first-order", participant = true, version = 1 }) {
  const { history, error, retry } = useOrderHistory(orderId, version, participant);
  return (
    <div>
      <span>{error ?? history?.entries[0]?.reason ?? "No private history"}</span>
      <button onClick={retry}>Retry</button>
    </div>
  );
}
const json = (reason: string, status = 200) =>
  new Response(
    JSON.stringify(
      status === 200
        ? {
            orderId: "first-order",
            entries: [
              {
                previousStatus: "DISPUTED",
                newStatus: "CANCELLED",
                action: "RESOLVE_FOR_REQUESTER",
                actorType: "ADMIN",
                actorId: "admin",
                reason,
                version: 8,
                occurredAt: "2026-10-28T06:00:00Z",
              },
            ],
          }
        : { error: { code: "PRIVATE_ORDER_FORBIDDEN", message: "Not a participant" } },
    ),
    { status, headers: { "content-type": "application/json" } },
  );
const realFetch = globalThis.fetch;
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
beforeEach(() => {
  auth.user = { id: "first-participant" };
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

describe("private errand history reads", () => {
  it("does not request an outsider's history and hides a previous result on identity change", async () => {
    const requests: Request[] = [];
    globalThis.fetch = (async (request: Request) => {
      requests.push(request);
      return json("Private decision reason");
    }) as typeof fetch;
    await act(async () => root.render(<Probe participant={false} />));
    await settle();
    expect(requests).toHaveLength(0);
    await act(async () => root.render(<Probe />));
    await settle();
    expect(container.textContent).toContain("Private decision reason");
    expect(new URL(requests[0].url).pathname).toBe("/orders/first-order/history");
    expect(requests[0].headers.get("authorization")).toBe("Bearer current-session");
    auth.user = { id: "another-person" };
    await act(async () => root.render(<Probe participant={false} />));
    expect(container.textContent).not.toContain("Private decision reason");
    expect(requests).toHaveLength(1);
  });

  it("ignores an old order's late response and retries an authorized failed read", async () => {
    let finish!: (response: Response) => void;
    let attempt = 0;
    globalThis.fetch = (async (request: Request) => {
      if (new URL(request.url).pathname.includes("first-order"))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return ++attempt === 1 ? json("", 403) : json("Current order reason");
    }) as typeof fetch;
    await act(async () => root.render(<Probe />));
    await settle();
    await act(async () => root.render(<Probe orderId="second-order" />));
    await settle();
    await act(async () => finish(json("Old order private reason")));
    await settle();
    expect(container.textContent).not.toContain("Old order private reason");
    expect(container.textContent).toContain("Try loading its history again");
    await act(async () => container.querySelector("button")!.click());
    await settle();
    expect(container.textContent).toContain("Current order reason");
    auth.user = null;
    await act(async () => root.render(<Probe orderId="second-order" />));
    expect(container.textContent).not.toContain("Current order reason");
  });
});
