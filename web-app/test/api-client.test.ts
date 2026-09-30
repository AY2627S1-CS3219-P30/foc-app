import { describe, expect, it } from "bun:test";
import { bearer, createApiClient, unwrap } from "../src/lib/api-client";
import type { paths } from "../src/lib/generated/supplier-service";
import { ApiError } from "../src/lib/user-api";

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

  it("refuses to call anywhere without a base URL", async () => {
    const api = createApiClient<paths>(null);
    expect(await unwrap(api.GET("/suppliers")).catch((e) => e)).toMatchObject({
      status: 0,
      code: "NOT_CONFIGURED",
    });
  });
});
