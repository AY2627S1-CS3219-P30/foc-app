import { describe, expect, it } from "bun:test";
import { ApiError } from "../src/lib/api-client";
import { ChatSocket, chatSocketUrl } from "../src/lib/chat-socket";

/** #346: the notify-only chat socket. Its frames only say when to read; polling covers every gap. */
const URL = "ws://edge.test/api/chat/socket";

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: unknown[] = [];
  closedWith?: number;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number) {
    this.closedWith = code;
    this.onclose?.({ code });
  }
  open() {
    this.onopen?.();
  }
  frame(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  async drop(code: number) {
    this.onclose?.({ code });
    await settle();
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

class Clock {
  timers: { id: number; ms: number; fn: () => void }[] = [];
  private next = 1;
  readonly timer = {
    set: (fn: () => void, ms: number) => {
      const id = this.next++;
      this.timers.push({ id, ms, fn });
      return id;
    },
    clear: (id: unknown) => {
      this.timers = this.timers.filter((t) => t.id !== id);
    },
  };
  get waiting() {
    return this.timers.map((t) => t.ms);
  }
  async fire() {
    const due = this.timers.splice(0);
    due.forEach((t) => t.fn());
    await settle();
  }
}

function setUp() {
  FakeSocket.all = [];
  const clock = new Clock();
  const live: boolean[] = [];
  const nudges: [string, number][] = [];
  const tokens: string[] = [];
  let token = "first-token";
  const socket = new ChatSocket({
    url: URL,
    // As the session does: one refresh and retry on a 401.
    authed: async (fn) => {
      tokens.push(token);
      try {
        return await fn(token);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) throw err;
        token = "refreshed-token";
        tokens.push(token);
        return fn(token);
      }
    },
    onLive: (value) => live.push(value),
    onMessages: (orderId, latestSeq) => nudges.push([orderId, latestSeq]),
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    random: () => 0.5,
    timer: clock.timer,
  });
  const last = () => FakeSocket.all.at(-1)!;
  const ready = async () => {
    last().open();
    last().frame({ type: "ready" });
    await settle();
  };
  return { clock, live, nudges, tokens, socket, last, ready };
}

describe("the chat socket's address", () => {
  it("is the Chat Service's /socket on the page's origin, never carrying a token", () => {
    expect(chatSocketUrl("/api/chat", "https://foc.test/request/a")).toBe(
      "wss://foc.test/api/chat/socket",
    );
    expect(chatSocketUrl("/api/chat", "http://localhost:3000/x")).toBe(
      "ws://localhost:3000/api/chat/socket",
    );
    expect(chatSocketUrl("http://localhost:3006", "http://localhost:3000/")).toBe(
      "ws://localhost:3006/socket",
    );
    expect(chatSocketUrl(null, "http://localhost:3000/")).toBeNull();
  });
});

describe("a chat panel's socket", () => {
  it("signs in with the first frame, is live at ready, and passes on each nudge", async () => {
    const t = setUp();
    t.socket.start();
    await settle();
    expect(t.last().url).toBe(URL);
    t.last().open();
    expect(t.last().sent).toEqual([{ type: "auth", token: "first-token" }]);
    expect(t.live).toEqual([]);
    t.last().frame({ type: "ready" });
    t.last().frame({ type: "messages", orderId: "a", latestSeq: 4 });
    t.last().onmessage?.({ data: "not json" });
    t.last().frame({ type: "messages", orderId: "a" });
    await settle();
    expect(t.live).toEqual([true]);
    expect(t.nudges).toEqual([["a", 4]]);
  });

  it("refreshes the token on 4401 before ready, and connects again with the new one", async () => {
    const t = setUp();
    t.socket.start();
    await settle();
    t.last().open();
    await t.last().drop(4401);
    expect(FakeSocket.all).toHaveLength(2);
    t.last().open();
    expect(t.last().sent).toEqual([{ type: "auth", token: "refreshed-token" }]);
    t.last().frame({ type: "ready" });
    await settle();
    expect(t.live).toEqual([true]);
    expect(t.clock.waiting).toEqual([]);
  });

  it("reconnects after a 4401 once ready, through the session again", async () => {
    const t = setUp();
    t.socket.start();
    await settle();
    await t.ready();
    await t.last().drop(4401);
    expect(t.live).toEqual([true, false]);
    expect(t.clock.waiting).toEqual([1_000]);
    await t.clock.fire();
    await t.last().drop(4401);
    expect(t.tokens).toEqual(["first-token", "first-token", "refreshed-token"]);
    await t.ready();
    expect(t.live).toEqual([true, false, true]);
  });

  for (const code of [4503, 4429, 1001, 1006, 4408, 4400]) {
    it(`polls on ${code} and reconnects on the backoff schedule, without a refresh`, async () => {
      const t = setUp();
      t.socket.start();
      await settle();
      for (const delay of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
        await t.last().drop(code);
        expect(t.clock.waiting).toEqual([delay]);
        await t.clock.fire();
      }
      expect(t.tokens.every((token) => token === "first-token")).toBe(true);
      expect(t.live).toEqual([]);
      await t.ready();
      await t.last().drop(code);
      expect(t.live).toEqual([true, false]);
      expect(t.clock.waiting).toEqual([1_000]);
    });
  }

  it("retries at once when the network is back, and stops for good until started", async () => {
    const t = setUp();
    t.socket.start();
    await settle();
    await t.last().drop(1006);
    await t.clock.fire();
    await t.last().drop(1006);
    expect(t.clock.waiting).toEqual([2_000]);
    t.socket.retryNow();
    await settle();
    expect(t.clock.waiting).toEqual([]);
    expect(FakeSocket.all).toHaveLength(3);
    await t.ready();
    t.socket.retryNow();
    expect(FakeSocket.all).toHaveLength(3);
    const open = t.last();
    t.socket.stop();
    await settle();
    expect(open.closedWith).toBe(1000);
    expect(t.live).toEqual([true, false]);
    expect(t.clock.waiting).toEqual([]);
    t.socket.start();
    await settle();
    expect(FakeSocket.all).toHaveLength(4);
  });

  it("ignores a socket stopped before it was ready", async () => {
    const t = setUp();
    t.socket.start();
    await settle();
    t.socket.stop();
    await settle();
    expect(t.clock.waiting).toEqual([]);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("opens nothing in a build without the Chat Service's address", async () => {
    const t = setUp();
    const socket = new ChatSocket({
      url: null,
      authed: (fn) => fn("token"),
      onLive: () => {},
      onMessages: () => {},
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      timer: t.clock.timer,
    });
    socket.start();
    await settle();
    expect(FakeSocket.all).toHaveLength(0);
    expect(t.clock.waiting).toEqual([]);
  });
});
