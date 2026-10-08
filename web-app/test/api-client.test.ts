import { describe, expect, it } from "bun:test";
import { bearer, createApiClient, newCorrelationId, unwrap } from "../src/lib/api-client";
import type { paths } from "../src/lib/generated/supplier-service";
import { ApiError, createUserApi, NOT_CONFIGURED_MESSAGE } from "../src/lib/user-api";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const page = { items: [], page: 2, pageSize: 10, total: 0 };

function client(
  respond: (request: Request, signal: AbortSignal) => Response | Promise<Response>,
  timeoutMs?: number,
) {
  const seen: Request[] = [];
  const api = createApiClient<paths>("http://supplier.test", {
    fetch: async (request, init) => {
      seen.push(request);
      return respond(request, init.signal!);
    },
    timeoutMs,
  });
  return { api, seen };
}

describe("createApiClient", () => {
  it("sends the typed query and bearer token, and returns the body", async () => {
    const { api, seen } = client(() => json(200, page));
    const result = await unwrap(
      api.GET("/suppliers", {
        params: { query: { page: 2, pageSize: 10, type: "CAFE" } },
        headers: bearer("t1"),
      }),
    );
    expect(result).toEqual(page);
    expect(seen[0].url).toBe("http://supplier.test/suppliers?page=2&pageSize=10&type=CAFE");
    expect(seen[0].headers.get("authorization")).toBe("Bearer t1");
  });

  it("turns the error envelope into an ApiError with its field details", async () => {
    const { api } = client(() =>
      json(422, {
        error: {
          code: "VALIDATION_FAILED",
          message: "One or more fields are invalid.",
          details: [{ field: "pageSize", code: "TOO_BIG", message: "At most 100." }],
        },
      }),
    );
    const error = await unwrap(api.GET("/suppliers")).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(error.fieldMessage("pageSize")).toBe("At most 100.");
  });

  it("reports an unreachable service as status 0", async () => {
    const { api } = client(() => {
      throw new TypeError("fetch failed");
    });
    expect(await unwrap(api.GET("/suppliers")).catch((e) => e)).toMatchObject({
      status: 0,
      code: "NETWORK",
    });
  });

  it("gives up on a hung service", async () => {
    const { api } = client(
      (_, signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      10,
    );
    expect(await unwrap(api.GET("/suppliers")).catch((e) => e)).toMatchObject({
      status: 0,
      code: "TIMEOUT",
    });
  });

  it("gives up on a body that never finishes", async () => {
    const { api } = client((_, signal) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"items":'));
          signal.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      return new Response(body, { status: 200 });
    }, 10);
    expect(await unwrap(api.GET("/suppliers")).catch((e) => e)).toMatchObject({
      status: 0,
      code: "TIMEOUT",
    });
  });

  it("treats a 2xx that is not JSON, or is empty, as not from the service", async () => {
    for (const body of ["<html>Bad gateway</html>", null]) {
      const { api } = client(() => new Response(body, { status: 200 }));
      expect(await unwrap(api.GET("/suppliers")).catch((e) => e)).toMatchObject({
        status: 0,
        code: "NETWORK",
      });
    }
  });

  it("leaves a request the caller cancelled as the caller's abort", async () => {
    const { api } = client(
      (_, signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const controller = new AbortController();
    const call = unwrap(api.GET("/suppliers", { signal: controller.signal })).catch((e) => e);
    controller.abort();
    const error = await call;
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.name).toBe("AbortError");
  });

  it("works where AbortSignal.any is missing (Safari before 17.4)", async () => {
    const any = AbortSignal.any;
    delete (AbortSignal as { any?: unknown }).any;
    try {
      const { api } = client(() => json(200, page));
      expect(await unwrap(api.GET("/suppliers"))).toEqual(page);
    } finally {
      AbortSignal.any = any;
    }
  });

  it("refuses to call anywhere without a base URL", async () => {
    const api = createApiClient<paths>(null);
    expect(await unwrap(api.GET("/suppliers")).catch((e) => e)).toMatchObject({
      status: 0,
      code: "NOT_CONFIGURED",
    });
  });
});

describe("createUserApi", () => {
  it("sends the refresh cookie and a JSON content type, even without a body", async () => {
    const seen: Request[] = [];
    const api = createUserApi({
      baseUrl: "http://user-service.test",
      fetch: async (request) => {
        seen.push(request);
        return new Response(null, { status: 204 });
      },
    });
    expect(await api.logout()).toBeUndefined();
    expect(seen[0].credentials).toBe("include");
    expect(seen[0].headers.get("content-type")).toBe("application/json");
  });

  it("explains a build made without the service's address", async () => {
    const error = await createUserApi({ baseUrl: null })
      .me("t1")
      .catch((e) => e);
    expect(error).toMatchObject({
      status: 0,
      code: "NOT_CONFIGURED",
      message: NOT_CONFIGURED_MESSAGE,
    });
  });
});

describe("correlation ID (PLT-04)", () => {
  it("gives a call made outside any user action an ID of its own", async () => {
    const { api, seen } = client(() => json(200, page));
    await unwrap(api.GET("/suppliers"));
    await unwrap(api.GET("/suppliers"));

    const [first, second] = seen.map((r) => r.headers.get("x-correlation-id"));
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("gives every call in one user action the same ID", async () => {
    const seen: Request[] = [];
    const api = createUserApi({
      baseUrl: "http://user.test",
      fetch: async (request) => {
        seen.push(request);
        return request.url.endsWith("/auth/login")
          ? json(200, {
              accessToken: "t1",
              tokenType: "Bearer",
              expiresIn: 900,
              user: { id: "u1", displayName: "Alex", roles: ["STUDENT"], status: "ACTIVE" },
            })
          : json(200, { id: "u1" });
      },
    });
    const action = newCorrelationId();
    await api.login("a@u.nus.edu", "correct-horse-battery-staple", action);
    await api.me("t1", action);
    await api.me("t1"); // a separate action

    const ids = seen.map((r) => r.headers.get("x-correlation-id"));
    expect(ids.slice(0, 2)).toEqual([action, action]);
    expect(ids[2]).toBeTruthy();
    expect(ids[2]).not.toBe(action);
  });

  it("keeps an ID the caller already set", async () => {
    const { api, seen } = client(() => json(200, page));
    await unwrap(api.GET("/suppliers", { headers: { "x-correlation-id": "retry-of-1" } }));

    expect(seen[0].headers.get("x-correlation-id")).toBe("retry-of-1");
  });

  it("still makes an ID where crypto.randomUUID is missing, as on a plain-HTTP LAN address", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      expect(newCorrelationId()).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });
});
