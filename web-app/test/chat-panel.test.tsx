import { afterAll, afterEach, beforeEach, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import type { Channel } from "../src/lib/chat-api";

const window = new Window({ url: "http://localhost:3000/request/order", width: 360 });
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const auth = {
  user: { id: "me" },
  authed: <T,>(fn: (token: string) => Promise<T>) => fn("test-token"),
};
mock.module("../src/lib/auth", () => ({ useAuth: () => auth }));
const { ChatPanel } = await import("../src/components/ChatPanel");
const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
const realObserver = globalThis.IntersectionObserver;
const realSocket = globalThis.WebSocket;
class FakeSocket {
  static all: FakeSocket[] = [];
  sent: unknown[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}
let observer: ((entries: { isIntersecting: boolean }[]) => void) | null;
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let timers: number[];
let requests: Request[];
let nextChannel: Channel;
let status: number;
let items: (typeof message)[];
const channel: Channel = {
  orderId: "order",
  open: true,
  myRole: "REQUESTER",
  requester: { userId: "me", displayName: "Mei Tan" },
  courier: { userId: "courier", displayName: "Arun Kumar" },
  lastReadSeq: 0,
  latestSeq: 1,
};
const message = {
  seq: 1,
  clientId: "incoming",
  senderId: "courier",
  body: "I am at COM2.",
  sentAt: "2026-11-03T08:00:00Z",
};
const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });
beforeEach(() => {
  auth.user = { id: "me" };
  window.happyDOM.setWindowSize({ width: 360, height: 780 });
  timers = [];
  requests = [];
  nextChannel = channel;
  status = 200;
  items = [message];
  observer = null;
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.setTimeout = ((fn: () => void, delay = 0) => {
    if (delay < 1000) return realTimeout(fn, delay);
    timers.push(delay);
    return 0;
  }) as typeof setTimeout;
  globalThis.IntersectionObserver = class {
    constructor(callback: typeof observer) {
      observer = callback;
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  globalThis.fetch = (async (r: Request) => {
    requests.push(r);
    if (status !== 200)
      return json({ error: { code: "REFUSED", message: "Not available" } }, status);
    if (r.method === "PUT") return json({ lastReadSeq: (await r.json()).seq });
    return json(r.url.includes("/messages") ? { items, hasMore: false } : nextChannel);
  }) as typeof fetch;
  container = document.createElement("div") as unknown as HTMLElement;
  document.body.appendChild(container as never);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
  globalThis.IntersectionObserver = realObserver;
  globalThis.WebSocket = realSocket;
});
afterAll(() => {
  for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"])
    delete (globalThis as Record<string, unknown>)[key];
});
const settle = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => new Promise((resolve) => realTimeout(resolve, 0)));
};
async function render(props: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  await act(async () => root.render(<ChatPanel orderId="order" {...props} />));
  await settle();
}
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === name)!;
async function open() {
  await act(async () => button("Open chat").click());
  await settle();
}

it("mounts one composer, collapses on phones, counts unread and polls every two seconds", async () => {
  await render();
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
  expect(container.querySelector("[hidden]")).not.toBeNull();
  expect(container.textContent).toContain("1 unread");
  expect(timers).toEqual([2000]);
  expect(requests.some((r) => r.method === "PUT")).toBe(false);
  await open();
  expect(container.textContent).toContain("Mei Tan");
  expect(container.textContent).toContain("Arun Kumar");
  expect(container.textContent).toContain(message.body);
  const input = container.querySelector("textarea")!;
  expect(container.querySelector("label")?.htmlFor).toBe(input.id);
  expect(input.hasAttribute("maxlength")).toBe(false);
});

it("only marks read when expanded, intersecting, visible and at bottom", async () => {
  await render();
  await open();
  const log = container.querySelector('[aria-label="Conversation messages"]')!;
  Object.defineProperty(log.lastElementChild!, "getClientRects", { value: () => [{ width: 300 }] });
  await act(async () => observer?.([{ isIntersecting: false }]));
  expect(requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  await act(async () => observer?.([{ isIntersecting: true }]));
  await settle();
  expect(requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  expect(container.textContent).toContain("0 unread");
});

it("re-opening waits for the bottom to be seen again before marking newer messages read", async () => {
  await render();
  await open();
  const log = container.querySelector('[aria-label="Conversation messages"]')!;
  Object.defineProperty(log.lastElementChild!, "getClientRects", { value: () => [{ width: 300 }] });
  await act(async () => observer?.([{ isIntersecting: true }]));
  await settle();
  expect(requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  await act(async () => button("Collapse chat").click());
  nextChannel = { ...channel, lastReadSeq: 1, latestSeq: 2 };
  items = [message, { ...message, seq: 2, clientId: "incoming-2", body: "Here now." }];
  await render({ version: 2 });
  expect(container.textContent).toContain("1 unread");
  await open();
  expect(requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  await act(async () => observer?.([{ isIntersecting: true }]));
  await settle();
  expect(requests.filter((r) => r.method === "PUT")).toHaveLength(2);
});

it("stops polling on closure, retains history and disables sending at a final state", async () => {
  nextChannel = { ...channel, open: false };
  await render({ final: true });
  await open();
  expect(timers).toEqual([]);
  expect(container.textContent).toContain(message.body);
  expect(container.textContent).toContain("This errand has ended");
  expect(container.querySelector("textarea")?.disabled).toBe(true);
  expect(button("Send").disabled).toBe(true);
});

it("hides 404 chat and rechecks availability on a new order revision", async () => {
  status = 404;
  await render();
  expect(container.textContent).toBe("");
  expect(timers).toEqual([]);
  status = 200;
  await render({ version: 2 });
  expect(container.textContent).toContain("Participant chat");
  expect(timers).toEqual([2000]);
});

it("keeps the admin console read only even when the API identifies a participant", async () => {
  await render({ readOnly: true });
  await open();
  expect(container.textContent).toContain(message.body);
  expect(container.textContent).toContain("Administrator view: read only");
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () => observer?.([{ isIntersecting: true }]));
  await settle();
  expect(requests.every((r) => r.method === "GET")).toBe(true);
  expect(timers).toEqual([]);
});

it("refreshes admin history on request and order revisions without scheduling polls", async () => {
  nextChannel = { ...channel, myRole: "ADMIN" };
  await render({ readOnly: true, version: 1 });
  await open();
  expect(timers).toEqual([]);
  requests = [];
  nextChannel = { ...nextChannel, latestSeq: 2 };
  items = [{ ...message, seq: 2, clientId: "incoming-2", body: "Here now." }];
  await act(async () => button("Refresh conversation").click());
  await settle();
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
    "/channels/order",
    "/channels/order/messages",
  ]);
  expect(container.textContent).toContain("Here now.");
  expect(timers).toEqual([]);
  requests = [];
  await render({ readOnly: true, version: 2 });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe("GET");
  expect(timers).toEqual([]);
});

it("does not poll transient admin errors and retries when requested", async () => {
  status = 503;
  await render({ readOnly: true });
  await open();
  expect(container.textContent).toContain("Could not refresh chat");
  expect(timers).toEqual([]);
  expect(requests).toHaveLength(1);
  status = 200;
  await act(async () => button("Try again").click());
  await settle();
  expect(container.textContent).toContain(message.body);
  expect(container.textContent).not.toContain("Could not refresh chat");
  expect(requests).toHaveLength(3);
  expect(requests.every((r) => r.method === "GET")).toBe(true);
  expect(timers).toEqual([]);
});

it("shows service authorization refusal without private names or text", async () => {
  status = 403;
  await render();
  await open();
  expect(container.textContent).toContain("You can't access this conversation");
  expect(container.textContent).not.toContain("Mei Tan");
  expect(container.textContent).not.toContain(message.body);
  expect(container.querySelector("textarea")).toBeNull();
});

it("resizing retains one textarea and identity/order changes replace private state", async () => {
  await render();
  await open();
  const textarea = container.querySelector("textarea");
  await act(async () => window.happyDOM.setWindowSize({ width: 1440, height: 900 }));
  await settle();
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
  expect(container.querySelector("textarea")).toBe(textarea);
  status = 403;
  auth.user = { id: "different-account" };
  await render({ orderId: "other-order" });
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.textContent).not.toContain(message.body);
  expect(container.textContent).not.toContain("Mei Tan");
});

it("reads at once on a nudge past its messages, and polls every 30 s while the socket is live", async () => {
  await render();
  expect(FakeSocket.all).toHaveLength(1);
  const socket = FakeSocket.all[0];
  expect(socket.url).toBe("ws://localhost:3006/socket");
  await act(async () => socket.onopen?.());
  expect(socket.sent).toEqual([{ type: "auth", token: "test-token" }]);
  requests = [];
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: "ready" }) }));
  await settle();
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/channels/order"]);
  expect(timers.at(-1)).toBe(30_000);
  requests = [];
  const nudge = (orderId: string, latestSeq: number) =>
    act(async () =>
      socket.onmessage?.({ data: JSON.stringify({ type: "messages", orderId, latestSeq }) }),
    );
  await nudge("order", 1);
  await nudge("other-order", 2);
  await settle();
  expect(requests).toHaveLength(0);
  nextChannel = { ...channel, latestSeq: 2 };
  items = [{ ...message, seq: 2, clientId: "incoming-2", body: "Here now." }];
  await nudge("order", 2);
  await settle();
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
    "/channels/order",
    "/channels/order/messages",
  ]);
  await open();
  expect(container.textContent).toContain("Here now.");
});

it("falls back to two-second polling at once when the socket drops", async () => {
  await render();
  const socket = FakeSocket.all[0];
  await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: "ready" }) }));
  await settle();
  expect(timers.at(-1)).toBe(30_000);
  requests = [];
  await act(async () => socket.onclose?.({ code: 1006 }));
  await settle();
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/channels/order"]);
  expect(timers.at(-1)).toBe(2_000);
});

it("opens no socket for a read-only view or a final errand", async () => {
  await render({ readOnly: true });
  nextChannel = { ...channel, open: false };
  await render({ orderId: "ended", final: true });
  expect(FakeSocket.all).toHaveLength(0);
});
