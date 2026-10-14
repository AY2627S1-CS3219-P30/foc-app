import { describe, expect, it } from "bun:test";
import { createAdminApi } from "../src/lib/admin-api";
import { ApiError } from "../src/lib/api-client";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const account = {
  id: "0198a1c2-5b3e-7c11-9d4a-2f8b6e1a7c30",
  email: "alex@u.nus.edu",
  roles: ["STUDENT", "ADMIN"],
  status: "ACTIVE",
  isSeededAdmin: false,
  profile: { displayName: "Alex", contactPreference: "IN_APP", preferredMode: "REQUESTER" },
  createdAt: "2026-10-01T08:00:00Z",
};

const request = {
  id: "0198a1c2-0000-7000-8000-000000000001",
  targetUserId: account.id,
  role: "ADMIN",
  requestedBy: "0198a1c2-0000-7000-8000-000000000002",
  reason: "New operations lead",
  status: "PENDING",
  createdAt: "2026-10-08T08:00:00Z",
  expiresAt: "2026-10-09T08:00:00Z",
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
};

/** The admin clients against one fake server that answers every call with `respond`. */
function api(respond: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const client = createAdminApi({
    userUrl: "http://user.test",
    orderUrl: "http://order.test",
    creditUrl: "http://credit.test",
    fetch: async (req) => {
      seen.push(req);
      return respond(req);
    },
  });
  return { client, seen };
}

describe("a role change", () => {
  it("that waits for a second administrator comes back as pending (202)", async () => {
    const { client, seen } = api(() => json(202, { request }));
    const result = await client.changeRole("t1", account.id, "ADMIN", "New operations lead");
    expect(result).toEqual({ kind: "pending", request } as never);
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].url).toBe(`http://user.test/admin/users/${account.id}/role`);
    expect(await seen[0].json()).toEqual({ role: "ADMIN", reason: "New operations lead" });
  });

  it("that applied at once comes back as the account (200)", async () => {
    const { client } = api(() => json(200, account));
    expect(await client.changeRole("t1", account.id, "ADMIN", "Only admin")).toEqual({
      kind: "applied",
      user: account,
    } as never);
  });

  it("that needs the password fails with STEP_UP_REQUIRED", async () => {
    const { client } = api(() =>
      json(401, {
        error: { code: "STEP_UP_REQUIRED", message: "Re-enter your password to confirm this action." },
      }),
    );
    const err = await client.changeRole("t1", account.id, "ADMIN", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: "STEP_UP_REQUIRED" });
  });
});

describe("the admin calls", () => {
  it("send the filters, the bearer token and the reason where each service expects them", async () => {
    const { client, seen } = api((req) =>
      req.url.includes("/auth/step-up")
        ? new Response(null, { status: 204 })
        : json(200, { page: 1, pageSize: 25, total: 0, items: [] }),
    );
    await client.audit("t1", { actorId: account.id, action: "SUSPEND", from: "2026-10-01T00:00:00.000Z" });
    await client.reject("t1", request.id, "Not this term");
    await client.stepUp("t1", "correct-horse-battery-staple");

    const audit = new URL(seen[0].url);
    expect(audit.pathname).toBe("/admin/audit-records");
    expect(Object.fromEntries(audit.searchParams)).toEqual({
      actorId: account.id,
      action: "SUSPEND",
      from: "2026-10-01T00:00:00.000Z",
    });
    expect(seen[0].headers.get("authorization")).toBe("Bearer t1");
    expect(seen[1].url).toBe(`http://user.test/admin/role-requests/${request.id}/reject`);
    expect(await seen[1].json()).toEqual({ reason: "Not this term" });
    expect(seen[2].url).toBe("http://user.test/auth/step-up");
  });

  it("reach each service at its own address, the directory included", async () => {
    const { client, seen } = api((req) =>
      req.url.includes("/ledger") ? json(200, { items: [], nextCursor: null }) : json(200, { items: [] }),
    );
    await client.creditWaits("t1");
    await client.directory("t1", { q: "ana" });
    await client.ledger("t1", account.id, "next-page");
    expect(seen[0].url).toBe("http://order.test/admin/orders/pending-credit");
    expect(seen[1].url).toBe("http://user.test/admin/directory?q=ana");
    expect(seen[2].url).toBe(
      `http://credit.test/admin/wallets/${account.id}/ledger?limit=20&cursor=next-page`,
    );
  });

  it("name the missing address when a build has none", async () => {
    const client = createAdminApi({ userUrl: "http://user.test", orderUrl: null, creditUrl: null });
    expect(await client.creditWaits("t1").catch((e: unknown) => e)).toMatchObject({
      code: "NOT_CONFIGURED",
      message: expect.stringContaining("NEXT_PUBLIC_ORDER_SERVICE_URL"),
    });
    expect(await client.wallet("t1", account.id).catch((e: unknown) => e)).toMatchObject({
      code: "NOT_CONFIGURED",
      message: expect.stringContaining("NEXT_PUBLIC_CREDIT_SERVICE_URL"),
    });
  });
});
