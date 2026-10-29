import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import type { LiveConnectionOptions, LiveStatus } from "../src/lib/live/connection";
import type { LiveNudge } from "../src/lib/live/live";
import type { Order } from "../src/lib/order-api";

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const auth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call("test-token"),
  user: { id: "me", profile: { displayName: "Me", preferredMode: "COURIER" as "COURIER" | "REQUESTER" } },
};
mock.module("../src/lib/auth", () => ({ useAuth: () => auth }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, back() {} }),
  useSearchParams: () => new URLSearchParams(),
}));
mock.module("../src/components/DesktopShell", () => ({
  DesktopShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const { LiveProvider, boardReadDelay, useLive } = await import("../src/lib/live/live");
const { useOrder } = await import("../src/lib/use-order");
const { default: FeedPage } = await import("../src/app/(app)/feed/page");
const { CreditsProvider } = await import("../src/lib/credits");
const { StoreProvider } = await import("../src/lib/store");
const { TopBar } = await import("../src/components/TopBar");
const { AppBar } = await import("../src/components/AppBar");
const { ScreenHeader } = await import("../src/components/ScreenHeader");
const { DesktopPanel } = await import("../src/components/DesktopPanel");

/**
 * N1.4 (#331): which reads a nudge from the live-update stream sets off. The stream is faked; the
 * hooks and pages are the real ones, reading from a fake Order and Credit Service.
 */
const ORDER_ID = "11111111-0000-4000-8000-000000000001";
const OTHER_ID = "11111111-0000-4000-8000-000000000002";
const NOW = new Date().toISOString();
const order = (changes: Partial<Order>): Order => ({
  orderId: ORDER_ID,
  supplier: {
    supplierId: "00000000-0000-4000-8000-000000000001",
    name: "Kopi Corner",
    type: "CAFE",
    building: "COM2",
    floor: "1",
    locationDescription: "By the stairs",
  },
  items: [{ name: "Kopi O", quantity: 1 }],
  deliveryZone: "PGP House 7",
  reward: 2,
  status: "ACCEPTED",
  version: 3,
  acceptanceDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  createdAt: NOW,
  updatedAt: NOW,
  serverTime: NOW,
  requesterId: "them",
  courierId: "me",
  ...changes,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let current = order({});
let reads: string[] = [];
const realFetch = globalThis.fetch;
const fakeServices = (async (input: RequestInfo | URL) => {
  const { pathname, search } = new URL(input instanceof Request ? input.url : String(input));
  reads.push(`${pathname}${search}`);
  if (pathname === `/orders/${ORDER_ID}`) return json(200, current);
  if (pathname === "/orders") return json(200, []);
  if (pathname === "/orders/mine") return json(200, { items: [], truncated: false });
  if (pathname === "/wallets/me") return json(200, { userId: "me", available: 5, reserved: 0, total: 5 });
  return json(404, { error: { code: "NOT_FOUND", message: "No", correlationId: "t" } });
}) as typeof fetch;
const count = (path: string) => reads.filter((r) => r === path).length;

/** The stream LiveProvider would open, driven by the test. */
function fakeStream() {
  const stream = {
    connects: 0,
    started: 0,
    stopped: 0,
    retried: 0,
    handlers: undefined as Pick<LiveConnectionOptions, "onEvent" | "onStatus"> | undefined,
    connect: (handlers: Pick<LiveConnectionOptions, "authed" | "onEvent" | "onStatus">) => {
      stream.connects += 1;
      stream.handlers = handlers;
      return {
        start: () => void (stream.started += 1),
        stop: () => void (stream.stopped += 1),
        retryNow: () => void (stream.retried += 1),
      };
    },
    emit: async (event: string, data = "{}") => {
      await act(async () => stream.handlers!.onEvent({ event, data }));
      await settle();
    },
    status: async (status: LiveStatus) => {
      await act(async () => stream.handlers!.onStatus(status));
    },
  };
  return stream;
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const render = async (node: React.ReactNode) => {
  await act(async () => root.render(node));
  await settle();
};
const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new window.Event("visibilitychange") as unknown as Event);
};

beforeEach(() => {
  current = order({});
  reads = [];
  auth.user.profile.preferredMode = "COURIER";
  globalThis.fetch = fakeServices;
  setVisibility("visible");
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

function Listener({ heard }: { heard: LiveNudge[] }) {
  useLive((nudge) => heard.push(nudge));
  return null;
}

describe("the tab's live-update stream", () => {
  it("is opened once for the tab, and hands every nudge to every page listening", async () => {
    const stream = fakeStream();
    const first: LiveNudge[] = [];
    const second: LiveNudge[] = [];
    await render(
      <LiveProvider connect={stream.connect}>
        <Listener heard={first} />
        <Listener heard={second} />
      </LiveProvider>,
    );
    await stream.emit("ready");
    await stream.emit("errand", JSON.stringify({ orderId: ORDER_ID, version: 4 }));
    await stream.emit("board");

    expect([stream.connects, stream.started]).toEqual([1, 1]);
    const expected = [{ kind: "ready" }, { kind: "errand", orderId: ORDER_ID, version: 4 }, { kind: "board" }];
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
  });

  it("ignores an event it does not know, or an errand nudge it cannot read", async () => {
    const stream = fakeStream();
    const heard: LiveNudge[] = [];
    await render(
      <LiveProvider connect={stream.connect}>
        <Listener heard={heard} />
      </LiveProvider>,
    );
    await stream.emit("message", "hello");
    await stream.emit("errand", "not json");
    await stream.emit("errand", JSON.stringify({ version: 2 }));
    await stream.emit("errand", JSON.stringify({ orderId: ORDER_ID }));

    expect(heard).toEqual([{ kind: "errand", orderId: ORDER_ID }]);
  });

  it("closes while the tab is hidden, opens again on return, and retries at once when back online", async () => {
    const stream = fakeStream();
    await render(<LiveProvider connect={stream.connect}>{null}</LiveProvider>);
    await act(async () => setVisibility("hidden"));
    await act(async () => setVisibility("visible"));
    await act(async () => void window.dispatchEvent(new window.Event("online")));

    expect([stream.started, stream.stopped, stream.retried]).toEqual([2, 1, 1]);
    await act(async () => root.unmount());
    expect(stream.stopped).toBe(2);
    root = createRoot(container);
  });

  it("opens nothing where it is switched off, and a page outside it listens to nothing", async () => {
    const stream = fakeStream();
    await render(
      <LiveProvider connect={stream.connect} enabled={false}>
        <Listener heard={[]} />
      </LiveProvider>,
    );
    await render(<Listener heard={[]} />);
    expect(stream.connects).toBe(0);
  });
});

function OrderProbe() {
  const { order } = useOrder(ORDER_ID);
  return <span>{order ? `${order.status} ${order.version}` : "none"}</span>;
}

describe("which reads a nudge sets off", () => {
  it("the errand page: its own errand at a newer version, the board while Accepted, and ready", async () => {
    const stream = fakeStream();
    await render(
      <LiveProvider connect={stream.connect}>
        <OrderProbe />
      </LiveProvider>,
    );
    const path = `/orders/${ORDER_ID}`;
    expect(count(path)).toBe(1);

    await stream.emit("errand", JSON.stringify({ orderId: OTHER_ID, version: 9 }));
    await stream.emit("errand", JSON.stringify({ orderId: ORDER_ID, version: 3 }));
    expect(count(path)).toBe(1); // another errand, or the version already shown

    current = order({ status: "PICKED_UP", version: 4 });
    await stream.emit("errand", JSON.stringify({ orderId: ORDER_ID, version: 4 }));
    expect(count(path)).toBe(2);
    expect(container.textContent).toBe("PICKED_UP 4");

    await stream.emit("board");
    expect(count(path)).toBe(2); // only an Accepted errand can lose its courier to the board

    await stream.emit("ready");
    expect(count(path)).toBe(3);
  });

  it("the errand page reads on the board while Accepted: a courier who loses it is not named on it", async () => {
    const stream = fakeStream();
    await render(
      <LiveProvider connect={stream.connect}>
        <OrderProbe />
      </LiveProvider>,
    );
    current = order({ status: "OPEN", version: 4, courierId: undefined });
    await stream.emit("board");
    expect(count(`/orders/${ORDER_ID}`)).toBe(2);
    expect(container.textContent).toBe("OPEN 4");
  });

  it("the courier's feed reads the open errands again on the board, after a spread delay", async () => {
    const stream = fakeStream();
    await render(
      <StoreProvider>
        <LiveProvider connect={stream.connect}>
          <FeedPage />
        </LiveProvider>
      </StoreProvider>,
    );
    expect(count("/orders")).toBe(1);
    await stream.emit("errand", JSON.stringify({ orderId: ORDER_ID, version: 4 }));
    await stream.emit("board");
    expect(count("/orders")).toBe(1); // not yet: every open feed would read at the same moment

    await act(async () => new Promise((resolve) => setTimeout(resolve, 1_050)));
    await settle();
    expect(count("/orders")).toBe(2);
  });

  it("the requester's feed reads their errands again on an errand nudge, and not on the board", async () => {
    auth.user.profile.preferredMode = "REQUESTER";
    const stream = fakeStream();
    await render(
      <StoreProvider>
        <LiveProvider connect={stream.connect}>
          <FeedPage />
        </LiveProvider>
      </StoreProvider>,
    );
    const mine = "/orders/mine?role=REQUESTER&active=true";
    expect(count(mine)).toBe(1);
    await stream.emit("board");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1_050)));
    expect(count(mine)).toBe(1);
    await stream.emit("errand", JSON.stringify({ orderId: ORDER_ID, version: 4 }));
    expect(count(mine)).toBe(2);
  });

  it("the wallet: any errand nudge, since credits move only with an errand, and ready", async () => {
    const stream = fakeStream();
    await render(
      <LiveProvider connect={stream.connect}>
        <CreditsProvider>{null}</CreditsProvider>
      </LiveProvider>,
    );
    expect(count("/wallets/me")).toBe(1);
    await stream.emit("board");
    expect(count("/wallets/me")).toBe(1);
    await stream.emit("errand", JSON.stringify({ orderId: OTHER_ID, version: 2 }));
    await stream.emit("ready");
    expect(count("/wallets/me")).toBe(3);
  });

  it("spreads the board's reads over a second", () => {
    expect(boardReadDelay(() => 0)).toBe(0);
    expect(boardReadDelay(() => 0.5)).toBe(500);
    expect(boardReadDelay(() => 0.9999)).toBeLessThan(1_000);
  });
});

describe("the label in the top bar", () => {
  it("says Live, Reconnecting… or Updating every 30 s, as a polite status, and nothing before", async () => {
    const stream = fakeStream();
    await render(
      <LiveProvider connect={stream.connect}>
        <CreditsProvider>
          <TopBar />
        </CreditsProvider>
      </LiveProvider>,
    );
    const label = () => container.querySelector('[role="status"]')?.textContent ?? null;
    expect(label()).toBeNull();

    await stream.status("live");
    expect(label()).toBe("Live");
    await stream.status("reconnecting");
    expect(label()).toBe("Reconnecting…");
    await stream.status("polling");
    expect(label()).toBe("Updating every 30 s");
  });

  it("is in the phone's app bar too, where the top bar is hidden", async () => {
    const stream = fakeStream();
    await render(
      <StoreProvider>
        <LiveProvider connect={stream.connect}>
          <AppBar title="Feed" />
        </LiveProvider>
      </StoreProvider>,
    );
    await stream.status("reconnecting");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Reconnecting…");
    expect(container.textContent).toContain("Feed");
  });

  it("is in the errand page's own headers, on a phone and on a desktop", async () => {
    const stream = fakeStream();
    await render(
      <LiveProvider connect={stream.connect}>
        <ScreenHeader title="Your request" />
        <DesktopPanel title="Your request">{null}</DesktopPanel>
      </LiveProvider>,
    );
    await stream.status("live");
    const labels = [...container.querySelectorAll('[role="status"]')].map((l) => l.textContent);
    expect(labels).toEqual(["Live", "Live"]);
  });

  it("is not shown where live updates are off", async () => {
    await render(
      <LiveProvider connect={fakeStream().connect} enabled={false}>
        <CreditsProvider>
          <TopBar />
        </CreditsProvider>
      </LiveProvider>,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
