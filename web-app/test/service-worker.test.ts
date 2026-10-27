import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const ORIGIN = "http://app.test";
const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

type FakeRequest = { method: string; url: string; mode: string };
type FetchEvent = { request: FakeRequest; respondWith: (answer: Promise<Response>) => void };

/**
 * Runs `public/sw.js` against a fake worker scope: its own origin, a Cache Storage held in a map,
 * and a network that answers until `offline()`. `get` dispatches a fetch event and says whether
 * the worker answered it (`undefined`: the browser goes to the network itself).
 */
function worker() {
  const listeners: Record<string, (event: FetchEvent) => void> = {};
  const stored = new Map<string, Response>();
  const key = (request: FakeRequest | string) =>
    typeof request === "string" ? new URL(request, ORIGIN).href : request.url;
  const cache = { put: async (request: FakeRequest, response: Response) => void stored.set(key(request), response) };
  const caches = {
    open: async () => cache,
    match: async (request: FakeRequest | string) => stored.get(key(request))?.clone(),
    keys: async () => [],
    delete: async () => true,
  };
  let online = true;
  const network = async (request: FakeRequest) => {
    if (!online) throw new TypeError("Failed to fetch");
    return new Response(`fresh ${request.url}`);
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: FetchEvent) => void) => (listeners[type] = listener),
    skipWaiting() {},
    clients: { claim: async () => {} },
  };
  new Function("self", "caches", "fetch", source)(self, caches, network);

  return {
    stored,
    offline: () => (online = false),
    async get(path: string, mode = "cors"): Promise<Response | undefined> {
      let answer: Promise<Response> | undefined;
      listeners.fetch!({ request: { method: "GET", url: new URL(path, ORIGIN).href, mode }, respondWith: (p) => (answer = p) });
      const response = answer && (await answer);
      // Let the worker's cache write land before the test looks.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return response;
    },
  };
}

describe("the service worker", () => {
  it("leaves a same-origin API call to the network, so its data is never stored or replayed", async () => {
    const sw = worker();
    expect(await sw.get("/orders/0198a1c2-0000-7000-8000-00000000e001")).toBeUndefined();
    expect(await sw.get("/api/suppliers?page=1")).toBeUndefined();
    expect(sw.stored.size).toBe(0);
  });

  it("leaves other origins alone", async () => {
    expect(await worker().get("http://localhost:3003/orders/mine")).toBeUndefined();
  });

  it("serves a page already visited when offline", async () => {
    const sw = worker();
    expect(await (await sw.get("/wallet", "navigate"))!.text()).toBe(`fresh ${ORIGIN}/wallet`);
    sw.offline();
    expect(await (await sw.get("/wallet", "navigate"))!.text()).toBe(`fresh ${ORIGIN}/wallet`);
  });

  it("falls back to the login shell for a page it has not seen", async () => {
    const sw = worker();
    await sw.get("/login", "navigate");
    sw.offline();
    expect(await (await sw.get("/feed", "navigate"))!.text()).toBe(`fresh ${ORIGIN}/login`);
  });

  it("keeps the build's static assets, and fails one it lacks instead of answering with a page", async () => {
    const sw = worker();
    await sw.get("/login", "navigate");
    await sw.get("/_next/static/chunks/app.js", "no-cors");
    sw.offline();
    expect(await (await sw.get("/_next/static/chunks/app.js", "no-cors"))!.text()).toBe(
      `fresh ${ORIGIN}/_next/static/chunks/app.js`,
    );
    expect((await sw.get("/_next/static/chunks/other.js", "no-cors"))!.type).toBe("error");
  });
});
