import { describe, expect, it } from "bun:test";
import {
  createSession,
  memoryFlag,
  type EndReason,
  type Flag,
  type Locks,
  type TabChannel,
} from "../src/lib/session";
import { ApiError, createUserApi } from "../src/lib/user-api";

type Handler = (req: {
  token?: string;
  signal: AbortSignal;
  correlationId: string | null;
}) => Response | Promise<Response>;

/** A fake User Service behind an injected `fetch`: answers from `routes` and counts calls per route. */
function fakeService(routes: Record<string, Handler>, timeoutMs?: number) {
  const calls: Record<string, number> = {};
  const fetch = async (request: Request, init: RequestInit) => {
    const key = `${request.method} ${new URL(request.url).pathname}`;
    calls[key] = (calls[key] ?? 0) + 1;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected call: ${key}`);
    const auth = request.headers.get("authorization") ?? undefined;
    return handler({
      token: auth?.replace(/^Bearer /, ""),
      signal: init.signal as AbortSignal,
      correlationId: request.headers.get("x-correlation-id"),
    });
  };
  return { api: createUserApi({ baseUrl: "http://user-service.test", fetch, timeoutMs }), calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const issued = (accessToken: string, userId = "u1") =>
  json(200, {
    accessToken,
    tokenType: "Bearer",
    expiresIn: 900,
    user: { id: userId, displayName: "Alex", roles: ["STUDENT"], status: "ACTIVE" },
  });
const refused = () =>
  json(401, { error: { code: "REFRESH_TOKEN_INVALID", message: "Session expired. Log in again." } });
const unauthenticated = () =>
  json(401, { error: { code: "UNAUTHENTICATED", message: "Authentication required." } });
const unavailable = () =>
  json(503, { error: { code: "INTERNAL", message: "Service unavailable." } });
const me = (id = "u1") => json(200, { id, email: "a@u.nus.edu", roles: ["STUDENT"], status: "ACTIVE" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Web Locks in miniature: one holder at a time per name, shared by every "tab" given it. */
function fakeLocks(): Locks {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

/** BroadcastChannel in miniature: a message reaches every other connected tab. */
function fakeHub() {
  const listeners = new Set<(m: unknown) => void>();
  return (): TabChannel => {
    let mine: ((m: unknown) => void) | null = null;
    return {
      post: (message) => listeners.forEach((l) => l !== mine && l(message)),
      subscribe(listener) {
        mine = listener;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  };
}

/** One tab's session, recording how it ended and whose token it was handed. */
function tab(
  api: ReturnType<typeof fakeService>["api"],
  opts: { locks?: Locks; logoutPending?: Flag } = {},
) {
  const ended: EndReason[] = [];
  const userChanges: string[] = [];
  const session = createSession({
    api,
    locks: opts.locks ?? fakeLocks(),
    logoutPending: opts.logoutPending,
    onEnded: (reason) => ended.push(reason),
    onUserChanged: (token) => userChanges.push(token),
  });
  return { session, ended, userChanges };
}

describe("an expired access token", () => {
  it("is refreshed once for three calls that all get 401", async () => {
    const { api, calls } = fakeService({
      "POST /auth/refresh": async () => {
        await tick();
        return issued("t1");
      },
      "GET /users/me": ({ token }) => (token === "t1" ? me() : unauthenticated()),
    });
    const { session, ended } = tab(api);
    session.signedIn("t0", "u1");

    const results = await Promise.all([1, 2, 3].map(() => session.authed((t) => api.me(t))));

    expect(results.map((r) => r.id)).toEqual(["u1", "u1", "u1"]);
    expect(calls["POST /auth/refresh"]).toBe(1);
    expect(session.token()).toBe("t1");
    expect(ended).toEqual([]);
  });

  it("retries a late 401 with the token another call already got, without rotating again", async () => {
    const { api, calls } = fakeService({
      "POST /auth/refresh": () => issued("t1"),
      "GET /users/me": ({ token }) => (token === "t1" ? me() : unauthenticated()),
    });
    const { session } = tab(api);
    session.signedIn("t0", "u1");

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // Starts with t0, but its request only lands after the other call has refreshed.
    const late = session.authed(async (t) => {
      await held;
      return api.me(t);
    });
    await session.authed((t) => api.me(t));
    release();

    expect((await late).id).toBe("u1");
    expect(calls["POST /auth/refresh"]).toBe(1);
  });
});

describe("a 401 that is not about the token", () => {
  it.each(["STEP_UP_REQUIRED", "INVALID_CREDENTIALS"])(
    "(%s) reaches the caller without a refresh or a replay",
    async (code) => {
      const { api, calls } = fakeService({
        "POST /auth/refresh": () => issued("t1"),
        "GET /users/me": () => json(401, { error: { code, message: "Re-enter your password." } }),
      });
      const { session, ended } = tab(api);
      session.signedIn("t0", "u1");

      const err = await session.authed((t) => api.me(t)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(code);
      expect(calls["GET /users/me"]).toBe(1);
      expect(calls["POST /auth/refresh"]).toBeUndefined();
      expect(session.token()).toBe("t0");
      expect(ended).toEqual([]);
    },
  );
});

describe("a user action (PLT-04)", () => {
  it("sends its correlation ID with the refresh it needed, and with the retried call", async () => {
    const seen: string[] = [];
    const { api } = fakeService({
      "POST /auth/refresh": ({ correlationId }) => {
        seen.push(`refresh ${correlationId}`);
        return issued("t1");
      },
      "GET /users/me": ({ token, correlationId }) => {
        seen.push(`me ${correlationId}`);
        return token === "t1" ? me() : unauthenticated();
      },
    });
    const { session } = tab(api);
    session.signedIn("t0", "u1");

    await session.authed((t) => api.me(t, "action-1"), "action-1");

    expect(seen).toEqual(["me action-1", "refresh action-1", "me action-1"]);
  });
});

describe("a refresh the service refuses", () => {
  it("signs out", async () => {
    const { api } = fakeService({
      "POST /auth/refresh": () => refused(),
      "GET /users/me": () => unauthenticated(),
    });
    const { session, ended } = tab(api);
    session.signedIn("t0", "u1");

    const err = await session.authed((t) => api.me(t)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(ended).toEqual(["noSession"]);
    expect(session.token()).toBeNull();
  });

  it("means no session on a cold load", async () => {
    const { api } = fakeService({ "POST /auth/refresh": () => refused() });
    const { session, ended } = tab(api);

    expect((await session.refresh()).kind).toBe("ended");
    expect(ended).toEqual(["noSession"]);
  });
});

describe("a refresh that gets no answer", () => {
  it.each([
    ["a 5xx", () => unavailable()],
    ["no network", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("(%s) keeps the session", async (_label, answer) => {
    const { api } = fakeService({
      "POST /auth/refresh": answer as Handler,
      "GET /users/me": () => unauthenticated(),
    });
    const { session, ended } = tab(api);
    session.signedIn("t0", "u1");

    const err = await session.authed((t) => api.me(t)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).not.toBe(401);
    expect(ended).toEqual([]);
    expect(session.token()).toBe("t0");
  });

  it("is reported as unavailable on a cold load, not as signed out", async () => {
    const { api } = fakeService({ "POST /auth/refresh": () => unavailable() });
    const { session, ended } = tab(api);

    const result = await session.refresh();

    expect(result.kind).toBe("unavailable");
    expect(ended).toEqual([]);
  });

  it("times out instead of holding the lock forever", async () => {
    let attempts = 0;
    const { api } = fakeService(
      {
        "POST /auth/refresh": ({ signal }) => {
          attempts++;
          // The first request hangs until aborted; the second answers.
          if (attempts > 1) return issued("t1");
          return new Promise<Response>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          );
        },
      },
      20,
    );
    const locks = fakeLocks();
    const { session } = tab(api, { locks });

    const first = await session.refresh();
    expect(first.kind).toBe("unavailable");
    expect(first.kind === "unavailable" && first.error.code).toBe("TIMEOUT");

    // The lock was released: the next refresh (here or in another tab) gets through.
    expect((await session.refresh()).kind).toBe("ok");
  });
});

describe("two tabs", () => {
  it("restored together refresh one after the other", async () => {
    let active = 0;
    let most = 0;
    let n = 0;
    const { api, calls } = fakeService({
      "POST /auth/refresh": async () => {
        most = Math.max(most, ++active);
        await tick();
        active--;
        return issued(`t${++n}`);
      },
    });
    const locks = fakeLocks();
    const a = tab(api, { locks });
    const b = tab(api, { locks });

    const [ra, rb] = await Promise.all([a.session.refresh(), b.session.refresh()]);

    expect(ra.kind).toBe("ok");
    expect(rb.kind).toBe("ok");
    expect(calls["POST /auth/refresh"]).toBe(2);
    expect(most).toBe(1);
  });

  it("sign out together", async () => {
    const { api } = fakeService({ "POST /auth/logout": () => new Response(null, { status: 204 }) });
    const hub = fakeHub();
    const a = tab(api);
    const b = tab(api);
    a.session.connect(hub());
    b.session.connect(hub());
    a.session.signedIn("ta", "u1");
    b.session.signedIn("tb", "u1");

    await a.session.logout();

    expect(a.ended).toEqual(["loggedOut"]);
    expect(b.ended).toEqual(["loggedOut"]);
    expect(b.session.token()).toBeNull();
  });

  it("reload the user, and do not replay a call, when the other tab signed in as someone else", async () => {
    const seen: string[] = [];
    const { api } = fakeService({
      "POST /auth/refresh": () => issued("t-other", "u2"),
      "PATCH /users/me": ({ token }) => {
        seen.push(token ?? "");
        return unauthenticated();
      },
    });
    const { session, userChanges } = tab(api);
    session.signedIn("t0", "u1");

    const err = await session
      .authed((t) => api.updateMe(t, { displayName: "Mine" }))
      .catch((e: unknown) => e);

    expect((err as ApiError).code).toBe("SESSION_CHANGED");
    expect(seen).toEqual(["t0"]);
    expect(userChanges).toEqual(["t-other"]);
  });
});

describe("signing out", () => {
  it("reports a sign-out the service never received, and finishes it on the next load", async () => {
    let logoutWorks = false;
    const routes: Record<string, Handler> = {
      "POST /auth/logout": () => (logoutWorks ? new Response(null, { status: 204 }) : unavailable()),
      "POST /auth/refresh": () => issued("t1"),
    };
    const { api, calls } = fakeService(routes);
    const pending = memoryFlag(); // stands in for localStorage, which outlives the page
    const first = tab(api, { logoutPending: pending });
    first.session.signedIn("t0", "u1");

    expect(await first.session.logout()).toBe(false);
    expect(first.session.logoutPending()).toBe(true);
    // Signed out here regardless: the in-memory token is gone.
    expect(first.ended).toEqual(["loggedOut"]);
    expect(first.session.token()).toBeNull();

    // The next load revokes the cookie instead of using it.
    logoutWorks = true;
    const next = tab(api, { logoutPending: pending });
    expect((await next.session.refresh()).kind).toBe("ended");
    expect(calls["POST /auth/refresh"]).toBeUndefined();
    expect(calls["POST /auth/logout"]).toBe(2);
    expect(next.session.logoutPending()).toBe(false);
  });

  it("can be retried by hand", async () => {
    let logoutWorks = false;
    const { api } = fakeService({
      "POST /auth/logout": () => (logoutWorks ? new Response(null, { status: 204 }) : unavailable()),
    });
    const { session } = tab(api);
    session.signedIn("t0", "u1");

    expect(await session.logout()).toBe(false);
    logoutWorks = true;
    expect(await session.retryLogout()).toBe(true);
    expect(session.logoutPending()).toBe(false);
  });

  it("is not undone by a refresh that was already in flight", async () => {
    let answer!: (r: Response) => void;
    const { api } = fakeService({
      "POST /auth/refresh": () => new Promise<Response>((resolve) => (answer = resolve)),
      "POST /auth/logout": () => new Response(null, { status: 204 }),
    });
    const { session } = tab(api);
    session.signedIn("t0", "u1");

    const late = session.refresh();
    await tick();
    await session.logout();
    answer(issued("t1"));

    expect((await late).kind).toBe("ended");
    expect(session.token()).toBeNull();
  });
});
