import { describe, expect, it } from "bun:test";
import { ApiError } from "../src/lib/api-client";
import { LiveConnection, reconnectDelay, type LiveStatus } from "../src/lib/live/connection";
import type { SseEvent } from "../src/lib/live/sse";

/**
 * N1.4 (#331): how a tab keeps its live-update stream. The reconnect schedule converges a dropped
 * stream within 10 s (WEB-04); the stream's own refusals leave the page polling for a minute.
 */
const URL = "http://edge.test/api/order/live";

/** Timers the test runs by hand. */
class Clock {
  now = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private next = 1;
  readonly timer = {
    set: (fn: () => void, ms: number) => {
      const id = this.next++;
      this.timers.push({ id, at: this.now + ms, fn });
      return id;
    },
    clear: (id: unknown) => {
      this.timers = this.timers.filter((t) => t.id !== id);
    },
  };
  /** The delay of the one timer waiting, if any. */
  get waiting(): number | undefined {
    return this.timers[0] && this.timers[0].at - this.now;
  }
  async advance(ms: number) {
    this.now += ms;
    for (const due of this.timers.filter((t) => t.at <= this.now)) {
      this.timers = this.timers.filter((t) => t !== due);
      due.fn();
    }
    await settle();
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A stream response whose body the test writes. */
function stream() {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (control = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    write: async (text: string) => {
      control.enqueue(encoder.encode(text));
      await settle();
    },
    end: async () => {
      control.close();
      await settle();
    },
  };
}
const refusal = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: code, correlationId: "t" } }), {
    status,
    headers: { "content-type": "application/json" },
  });

function setUp(answers: (() => Response | Promise<Response>)[]) {
  const clock = new Clock();
  const requests: { url: string; authorization: string | null; signal?: AbortSignal | null }[] = [];
  const statuses: LiveStatus[] = [];
  const events: SseEvent[] = [];
  let token = "first-token";
  const connection = new LiveConnection({
    url: URL,
    // As the session does: one refresh and retry on a 401.
    authed: async (fn) => {
      try {
        return await fn(token);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) throw err;
        token = "refreshed-token";
        return fn(token);
      }
    },
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init.headers).get("authorization"),
        signal: init.signal,
      });
      const answer = answers.shift();
      if (!answer) throw new TypeError("Failed to fetch");
      return answer();
    }) as typeof fetch,
    onStatus: (status) => statuses.push(status),
    onEvent: (event) => events.push(event),
    random: () => 0.5,
    timer: clock.timer,
  });
  return { clock, requests, statuses, events, connection };
}

describe("the reconnect schedule", () => {
  it("waits 1, 2, 4 and 8 s, then 10 s, each spread by up to a fifth, never past 10 s", () => {
    expect([0, 1, 2, 3, 4, 9].map((n) => reconnectDelay(n, () => 0.5))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
    expect(reconnectDelay(0, () => 0)).toBe(800);
    expect(reconnectDelay(0, () => 1)).toBe(1_200);
    expect(reconnectDelay(9, () => 1)).toBe(10_000);
  });
});

describe("a tab's live-update stream", () => {
  it("opens with the bearer token, passes on every event, and is Live once the stream says ready", async () => {
    const live = stream();
    const t = setUp([() => live.response]);
    t.connection.start();
    await settle();
    expect(t.requests).toEqual([{ url: URL, authorization: "Bearer first-token", signal: expect.anything() }]);

    await live.write('event: ready\ndata: {}\n\nevent: errand\ndata: {"orderId":"a","version":3}\n\n');
    expect(t.statuses).toEqual(["live"]);
    expect(t.events.map((e) => e.event)).toEqual(["ready", "errand"]);
  });

  it("refreshes an expired token once, through the session, and then streams", async () => {
    const live = stream();
    const t = setUp([() => refusal(401, "TOKEN_EXPIRED"), () => live.response]);
    t.connection.start();
    await settle();
    await live.write("event: ready\ndata: {}\n\n");

    expect(t.requests.map((r) => r.authorization)).toEqual(["Bearer first-token", "Bearer refreshed-token"]);
    expect(t.statuses).toEqual(["live"]);
  });

  it("reconnects quietly after the stream ends, as it does every five minutes, still saying Live", async () => {
    const first = stream();
    const second = stream();
    const t = setUp([() => first.response, () => second.response]);
    t.connection.start();
    await settle();
    await first.write("event: ready\ndata: {}\n\n");
    await first.end();

    expect(t.clock.waiting).toBe(1_000);
    expect(t.statuses).toEqual(["live"]);
    await t.clock.advance(1_000);
    await second.write("event: ready\ndata: {}\n\n");
    expect(t.requests).toHaveLength(2);
    expect(t.statuses).toEqual(["live"]);
  });

  it("says Reconnecting… from the second failure in a row, and Updating every 30 s from the fourth", async () => {
    const t = setUp([]);
    t.connection.start();
    await settle();
    const delays: (number | undefined)[] = [t.clock.waiting];
    for (let i = 0; i < 4; i++) {
      await t.clock.advance(t.clock.waiting!);
      delays.push(t.clock.waiting);
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 10_000]);
    // Reported as it changes. The first failure says nothing: it is usually a moment's drop.
    expect(t.statuses).toEqual(["reconnecting", "polling"]);
  });

  it("starts again from 1 s, and says Live, once a reconnect succeeds", async () => {
    const live = stream();
    const t = setUp([() => Promise.reject(new TypeError("Failed to fetch")), () => live.response]);
    t.connection.start();
    await settle();
    await t.clock.advance(1_000);
    await live.write("event: ready\ndata: {}\n\n");
    await live.end();

    expect(t.statuses).toEqual(["live"]);
    expect(t.clock.waiting).toBe(1_000);
  });

  it("polls, and asks again a minute later, when the stream itself refuses", async () => {
    for (const [status, code] of [
      [429, "TOO_MANY_STREAMS"],
      [503, "LIVE_UNAVAILABLE"],
    ] as const) {
      const t = setUp([() => refusal(status, code)]);
      t.connection.start();
      await settle();
      expect(t.statuses).toEqual(["polling"]);
      expect(t.clock.waiting).toBe(60_000);
    }
  });

  it("treats the edge's 503 while the Order Service restarts as a drop: the usual backoff", async () => {
    const t = setUp([() => refusal(503, "UNAVAILABLE")]);
    t.connection.start();
    await settle();
    expect(t.clock.waiting).toBe(1_000);
  });

  it("stops for good when stopped: the open stream is aborted and nothing is retried", async () => {
    const live = stream();
    const t = setUp([() => live.response]);
    t.connection.start();
    await settle();
    await live.write("event: ready\ndata: {}\n\n");
    t.connection.stop();
    await settle();

    expect(t.requests[0]!.signal!.aborted).toBe(true);
    expect(t.clock.waiting).toBeUndefined();
  });

  it("connects again at once when told the network is back, instead of waiting out its backoff", async () => {
    const live = stream();
    const t = setUp([() => Promise.reject(new TypeError("Failed to fetch")), () => live.response]);
    t.connection.start();
    await settle();
    expect(t.clock.waiting).toBe(1_000);

    t.connection.retryNow();
    await settle();
    await live.write("event: ready\ndata: {}\n\n");
    expect(t.requests).toHaveLength(2);
    expect(t.statuses.at(-1)).toBe("live");
    expect(t.clock.waiting).toBeUndefined();
  });

  it("never connects in a build without the Order Service's address, and says the page polls", async () => {
    const statuses: LiveStatus[] = [];
    const connection = new LiveConnection({
      url: null,
      authed: () => Promise.reject(new Error("not called")),
      onStatus: (status) => statuses.push(status),
      onEvent: () => {},
    });
    connection.start();
    await settle();
    expect(statuses).toEqual(["polling"]);
  });
});
