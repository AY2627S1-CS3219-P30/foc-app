import { afterEach, describe, expect, it } from "bun:test";
import { newCorrelationId } from "../src/lib/api-client";
import { createChatState, messageLength, validMessage } from "../src/lib/chat-state";
import type { Channel, Message } from "../src/lib/chat-api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const channel: Channel = {
  orderId: "order",
  open: true,
  myRole: "REQUESTER",
  requester: { userId: "me", displayName: "Mei Tan" },
  courier: { userId: "courier", displayName: "Arun Kumar" },
  lastReadSeq: 0,
  latestSeq: 0,
};
const msg = (seq: number, extra: Partial<Message> = {}): Message => ({
  seq,
  clientId: `id-${seq}`,
  senderId: "courier",
  body: `Message ${seq}`,
  sentAt: "2026-11-03T08:00:00Z",
  ...extra,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const refusal = (status: number, code: string) =>
  json({ error: { code, message: code, correlationId: "test" } }, status);
const make = (readOnly = false, who = "me", order = "order") =>
  createChatState(order, who, (fn) => fn("token"), readOnly);
const refresh = (store: ReturnType<typeof make>, final = false) =>
  store.refresh(new AbortController().signal, final);
function serve(
  handler: (request: Request, query: URLSearchParams) => Response | Promise<Response>,
) {
  globalThis.fetch = (async (request: Request) =>
    handler(request, new URL(request.url).searchParams)) as typeof fetch;
}
const basic = (request: Request) =>
  json(request.url.endsWith("/order") ? channel : { items: [], hasMore: false });

it("validates Unicode code points, whitespace and RFC4122 browser UUIDs", () => {
  expect(messageLength("😀".repeat(280))).toBe(280);
  expect(validMessage("😀".repeat(280))).toBe(true);
  expect(validMessage("😀".repeat(281))).toBe(false);
  expect(validMessage("\n \t")).toBe(false);
  expect(validMessage("")).toBe(false);
  expect(validMessage("a\0b")).toBe(false);
  expect(newCorrelationId()).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
});

describe("chat reads", () => {
  it("pages all unread history and reconnect catch-up, merges by seq and retains its cursor on a partial failure", async () => {
    const store = make();
    let reconnect = false;
    let broken = true;
    const afters: string[] = [];
    serve((r, q) => {
      if (r.url.endsWith("/order")) return json({ ...channel, latestSeq: reconnect ? 7 : 4 });
      if (!q.has("after")) return json({ items: [msg(3), msg(4)], hasMore: true });
      const after = q.get("after")!;
      afters.push(after);
      if (after === "0") return json({ items: [msg(1), msg(2)], hasMore: true });
      if (after === "2") return json({ items: [msg(3), msg(4)], hasMore: false });
      if (after === "4") return json({ items: [msg(5), msg(6)], hasMore: true });
      if (broken) return refusal(503, "UNAVAILABLE");
      return json({ items: [msg(7)], hasMore: false });
    });
    expect(await refresh(store)).toBe(2000);
    expect(store.snapshot().messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    reconnect = true;
    expect(await refresh(store)).toBe(2000);
    expect(store.snapshot().error?.status).toBe(503);
    broken = false;
    await refresh(store);
    expect(afters).toEqual(["0", "4", "6", "6"]);
    expect(store.snapshot().messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(store.snapshot().error).toBeNull();
  });

  it.each([
    [140, [], 100],
    [10, ["10"], 140],
  ])(
    "fetches the latest page once, plus only the unread before it (read to %i)",
    async (lastReadSeq, expected, loaded) => {
      const store = make();
      const afters: string[] = [];
      const range = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
      serve((r, q) => {
        if (r.url.endsWith("/order")) return json({ ...channel, latestSeq: 150, lastReadSeq });
        if (!q.has("after")) return json({ items: range(51, 150), hasMore: true });
        const after = Number(q.get("after"));
        afters.push(String(after));
        return json({ items: range(after + 1, Math.min(after + 100, 150)), hasMore: after + 100 < 150 });
      });
      await refresh(store);
      expect(afters).toEqual(expected);
      expect(store.snapshot().messages).toHaveLength(loaded);
      expect(store.unread()).toBe(150 - lastReadSeq);
    },
  );

  it("an idle poll asks only for the channel and re-renders nothing", async () => {
    const store = make();
    const urls: string[] = [];
    serve((r) => {
      urls.push(new URL(r.url).pathname);
      return r.url.endsWith("/order")
        ? json({ ...channel, latestSeq: 1 })
        : json({ items: [msg(1)], hasMore: false });
    });
    await refresh(store);
    urls.length = 0;
    let renders = 0;
    store.subscribe(() => renders++);
    await refresh(store);
    expect(urls).toEqual(["/channels/order"]);
    expect(renders).toBe(0);
  });

  it("loads older history with before and refreshes another device's read position", async () => {
    const store = make();
    let lastReadSeq = 10;
    const cursors: string[] = [];
    serve((r, q) => {
      if (r.url.endsWith("/order")) return json({ ...channel, latestSeq: 10, lastReadSeq });
      if (q.has("before")) {
        cursors.push(q.get("before")!);
        return json({ items: [msg(6), msg(7), msg(8)], hasMore: true });
      }
      return json({ items: [msg(9), msg(10)], hasMore: !q.has("after") });
    });
    await refresh(store);
    expect(store.snapshot().hasOlder).toBe(true);
    await store.older();
    expect(cursors).toEqual(["9"]);
    expect(store.snapshot().messages.map((m) => m.seq)).toEqual([6, 7, 8, 9, 10]);
    lastReadSeq = 11;
    await refresh(store);
    expect(store.snapshot().channel?.lastReadSeq).toBe(11);
  });

  it("counts only confirmed incoming unread and marks read only when visible at the bottom", async () => {
    const store = make();
    const marked: number[] = [];
    let lastReadSeq = 1;
    serve(async (r) => {
      if (r.method === "PUT") {
        marked.push((await r.json()).seq);
        return json({ lastReadSeq: 3 });
      }
      if (r.url.endsWith("/order")) return json({ ...channel, latestSeq: 3, lastReadSeq });
      return json({ items: [msg(1), msg(2, { senderId: "me" }), msg(3)], hasMore: false });
    });
    await refresh(store);
    expect(store.unread()).toBe(1);
    await store.markVisibleRead(false, true);
    await store.markVisibleRead(true, false);
    expect(marked).toEqual([]);
    await store.markVisibleRead(true, true);
    expect(marked).toEqual([3]);
    expect(store.unread()).toBe(0);
    lastReadSeq = 0;
    await refresh(store);
    expect(store.snapshot().channel?.lastReadSeq).toBe(3);
  });

  it.each([401, 403, 404])("purges private names and messages after %i", async (status) => {
    const store = make();
    serve((r) =>
      r.url.endsWith("/order") ? json(channel) : json({ items: [msg(1)], hasMore: false }),
    );
    await refresh(store);
    serve(() => refusal(status, "REFUSED"));
    expect(await refresh(store)).toBeNull();
    expect(store.snapshot().messages).toEqual([]);
    expect(store.snapshot().channel).toBeNull();
    expect(store.snapshot().absent).toBe(status === 404);
  });

  it("keeps history through network/service failures, and stops timers for closed/final channels", async () => {
    const store = make();
    serve((r) =>
      r.url.endsWith("/order")
        ? json({ ...channel, open: false })
        : json({ items: [msg(1)], hasMore: false }),
    );
    expect(await refresh(store)).toBeNull();
    serve(() => refusal(503, "UNAVAILABLE"));
    expect(await refresh(store)).toBeNull();
    expect(store.snapshot().messages).toHaveLength(1);
    expect(store.snapshot().error?.code).toBe("UNAVAILABLE");
    serve(basic);
    expect(await refresh(store, true)).toBeNull();
    await store.send("No final sends", true);
    expect(store.snapshot().outgoing).toEqual([]);
  });
});

describe("chat sends", () => {
  it.each([200, 201])(
    "shows pending immediately and reconciles a %i without duplicates",
    async (status) => {
      const store = make();
      let confirm!: (r: Response) => void;
      let sent!: { clientId: string; body: string };
      serve(async (r) => {
        if (r.method === "POST") {
          sent = await r.json();
          return new Promise<Response>((resolve) => {
            confirm = resolve;
          });
        }
        return basic(r);
      });
      await refresh(store);
      const sending = store.send("At COM2", false);
      expect(store.snapshot().outgoing[0]?.state).toBe("pending");
      await Bun.sleep(0);
      const message = msg(1, { ...sent, senderId: "me" });
      confirm(json(message, status));
      await sending;
      expect(store.snapshot().outgoing).toEqual([]);
      serve((r) =>
        r.url.endsWith("/order") ? json(channel) : json({ items: [message], hasMore: false }),
      );
      await refresh(store);
      expect(store.snapshot().messages).toEqual([message]);
    },
  );

  it("retries with the same clientId and unchanged body after an uncertain network result", async () => {
    const store = make();
    const bodies: unknown[] = [];
    serve(async (r) => {
      if (r.method !== "POST") return basic(r);
      const body = await r.json();
      bodies.push(body);
      if (bodies.length === 1) throw new TypeError("offline");
      return json(msg(1, { ...body, senderId: "me" }));
    });
    await refresh(store);
    await store.send("  Original body 😀  ", false);
    expect(store.snapshot().outgoing[0]?.state).toBe("failed");
    expect(store.snapshot().messages).toEqual([]);
    await store.retry(store.snapshot().outgoing[0].clientId, false);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(store.snapshot().outgoing).toEqual([]);
  });

  it("never jumps the fetch/read cursor past messages preceding a send response", async () => {
    const store = make();
    const afters: string[] = [];
    let posted = false;
    serve(async (r, q) => {
      if (r.method === "POST") {
        posted = true;
        return json(msg(5, { ...(await r.json()), senderId: "me" }), 201);
      }
      if (r.url.endsWith("/order")) return json({ ...channel, latestSeq: posted ? 5 : 0 });
      afters.push(q.get("after") ?? "latest");
      return json({ items: [], hasMore: false });
    });
    await refresh(store);
    await store.send("Fifth", false);
    await refresh(store);
    expect(afters).toEqual(["latest", "0"]);
  });

  it("preserves Retry-After, blocks sends until it passes, and latches CHANNEL_CLOSED", async () => {
    const store = make();
    let posts = 0;
    serve((r) => {
      if (r.method === "POST") {
        posts++;
        return json({ error: { code: "RATE_LIMITED", message: "Wait" } }, 429, {
          "Retry-After": "12",
        });
      }
      return basic(r);
    });
    await refresh(store);
    const before = Date.now();
    await store.send("Slow down", false);
    expect(store.snapshot().retryAt).toBeGreaterThanOrEqual(before + 12000);
    await store.send("Too soon", false);
    expect(posts).toBe(1);
    const closed = make();
    serve((r) => (r.method === "POST" ? refusal(409, "CHANNEL_CLOSED") : basic(r)));
    await refresh(closed);
    await closed.send("Closed", false);
    expect(closed.snapshot().closed).toBe(true);
    expect(closed.snapshot().outgoing[0]?.state).toBe("failed");
    await closed.send("Again", false);
    expect(closed.snapshot().outgoing).toHaveLength(1);
  });

  it("admins cannot send or mark read, including an admin who is a participant in the console", async () => {
    const store = make(true);
    const methods: string[] = [];
    serve((r) => {
      methods.push(r.method);
      return basic(r);
    });
    await refresh(store);
    await store.send("No", false);
    await store.markVisibleRead(true, true);
    expect(methods.every((method) => method === "GET")).toBe(true);
    expect(store.unread()).toBe(0);
  });

  it("ignores stale reads and sends after identity/order lifecycle cleanup", async () => {
    const store = make();
    const unmount = store.mount();
    let reply!: (r: Response) => void;
    serve((r) =>
      r.method === "POST"
        ? new Promise<Response>((resolve) => {
            reply = resolve;
          })
        : basic(r),
    );
    await refresh(store);
    const sending = store.send("Private", false);
    await Bun.sleep(0);
    unmount();
    reply(json(msg(1), 201));
    await sending;
    expect(store.snapshot().messages).toEqual([]);
    const other = make(false, "other", "other-order");
    expect(other.snapshot().messages).toEqual([]);
    expect(other.snapshot().outgoing).toEqual([]);
    const abort = new AbortController();
    serve(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        }),
    );
    const reading = other.refresh(abort.signal, false);
    abort.abort();
    reply(json(channel));
    await reading;
    expect(other.snapshot().channel).toBeNull();
  });
});

it("cannot resurrect older history or a send after concurrent access revocation", async () => {
  const store = make();
  let channelStatus = 200;
  let olderReply!: (r: Response) => void;
  let sendReply!: (r: Response) => void;
  serve((r, q) => {
    if (r.method === "POST")
      return new Promise<Response>((resolve) => {
        sendReply = resolve;
      });
    if (r.url.endsWith("/order"))
      return channelStatus === 200
        ? json({ ...channel, lastReadSeq: 3 })
        : refusal(403, "NOT_PARTICIPANT");
    if (q.has("before"))
      return new Promise<Response>((resolve) => {
        olderReply = resolve;
      });
    return json({ items: [msg(3)], hasMore: false });
  });
  await refresh(store);
  const older = store.older();
  const sending = store.send("In flight", false);
  await Bun.sleep(0);
  channelStatus = 403;
  await refresh(store);
  olderReply(json({ items: [msg(1), msg(2)], hasMore: false }));
  sendReply(json(msg(4), 201));
  await Promise.all([older, sending]);
  expect(store.snapshot().messages).toEqual([]);
  expect(store.snapshot().outgoing).toEqual([]);
  expect(store.snapshot().channel).toBeNull();
});

it("a GET confirmation wins over a later failed POST without duplicating or resurrecting pending text", async () => {
  const store = make();
  let rejectSend!: (error: Error) => void;
  let sent: { clientId: string; body: string } | null = null;
  serve(async (r) => {
    if (r.method === "POST") {
      sent = await r.json();
      return new Promise<Response>((_, reject) => {
        rejectSend = reject;
      });
    }
    if (r.url.endsWith("/order")) return json({ ...channel, latestSeq: sent ? 1 : 0 });
    return json({ items: sent ? [msg(1, { ...sent, senderId: "me" })] : [], hasMore: false });
  });
  await refresh(store);
  const sending = store.send("Stored but response lost", false);
  await Bun.sleep(0);
  await refresh(store);
  rejectSend(new TypeError("lost response"));
  await sending;
  expect(store.snapshot().messages).toHaveLength(1);
  expect(store.snapshot().outgoing).toEqual([]);
});
