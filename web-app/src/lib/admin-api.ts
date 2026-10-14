/**
 * The admin console's calls (ADM-02), typed from the contracts: the User Service's administration
 * and its controls on administrators (ADR 0008), the Order Service's operator views, and the Credit
 * Service's read-only wallets. Every call carries an administrator's access token, and every service
 * refuses anyone else on its own — hiding the console from students is presentation only.
 */

import { bearer, createApiClient, serviceUrl, unwrap, type Send } from "./api-client";
import type {
  components as CreditComponents,
  paths as CreditPaths,
} from "./generated/credit-service";
import type { components as OrderComponents, paths as OrderPaths } from "./generated/order-service";
import type { components as UserComponents, paths as UserPaths } from "./generated/user-service";
import { NOT_CONFIGURED_MESSAGE, USER_SERVICE_URL } from "./user-api";

type UserSchemas = UserComponents["schemas"];
type OrderSchemas = OrderComponents["schemas"];
type CreditSchemas = CreditComponents["schemas"];

export type AdminUser = UserSchemas["AdminUser"];
/** An account's standing without its profile; reading the directory is not recorded per account. */
export type DirectoryEntry = UserSchemas["DirectoryEntry"];
export type AccountStatus = UserSchemas["AccountStatus"];
export type Role = UserSchemas["Role"];
export type AuditRecord = UserSchemas["AuditRecord"];
export type AuditAction = UserSchemas["AuditAction"];
export type RoleChangeRequest = UserSchemas["RoleChangeRequest"];
export type RoleRequestStatus = UserSchemas["RoleRequestStatus"];
export type AdminRead = UserSchemas["AdminRead"];
export type AdminAlert = UserSchemas["AdminAlert"];
export type AdminAlertKind = UserSchemas["AdminAlertKind"];
export type CreditWait = OrderSchemas["CreditWaitList"]["items"][number];
export type ReconciliationAttempt = OrderSchemas["ReconciliationAttempts"]["items"][number];
export type Wallet = CreditSchemas["Wallet"];
export type LedgerItem = CreditSchemas["LedgerItem"];

export const ORDER_SERVICE_URL = serviceUrl(
  process.env.NEXT_PUBLIC_ORDER_SERVICE_URL,
  "http://localhost:3003",
);
export const CREDIT_SERVICE_URL = serviceUrl(
  process.env.NEXT_PUBLIC_CREDIT_SERVICE_URL,
  "http://localhost:3004",
);

/** A role change either applied at once, or waits for a second administrator (ADR 0008). */
export type RoleChange =
  | { kind: "applied"; user: AdminUser }
  | { kind: "pending"; request: RoleChangeRequest };

type Paging = { page?: number; pageSize?: number };
export type UserQuery = Paging & { q?: string; status?: AccountStatus; role?: Role };
export type AuditQuery = Paging & {
  targetUserId?: string;
  actorId?: string;
  action?: AuditAction;
  from?: string;
  to?: string;
};
export type ReadsQuery = Paging & { actorId?: string; targetUserId?: string };

/** The ledger page size the console asks for. */
export const LEDGER_PAGE = 20;

/** Builds the clients. The app uses {@link adminApi}; tests pass their own `fetch`. */
export function createAdminApi({
  userUrl,
  orderUrl,
  creditUrl,
  fetch,
  timeoutMs,
}: {
  userUrl: string | null;
  orderUrl: string | null;
  creditUrl: string | null;
  fetch?: Send;
  timeoutMs?: number;
}) {
  const users = createApiClient<UserPaths>(userUrl, {
    fetch,
    timeoutMs,
    notConfiguredMessage: NOT_CONFIGURED_MESSAGE,
  });
  const orders = createApiClient<OrderPaths>(orderUrl, {
    fetch,
    timeoutMs,
    notConfiguredMessage:
      "Errands are unavailable: NEXT_PUBLIC_ORDER_SERVICE_URL is missing from this build.",
  });
  const credit = createApiClient<CreditPaths>(creditUrl, {
    fetch,
    timeoutMs,
    notConfiguredMessage:
      "Wallets are unavailable: NEXT_PUBLIC_CREDIT_SERVICE_URL is missing from this build.",
  });
  const user = (userId: string) => ({ path: { userId } });
  const request = (requestId: string) => ({ path: { requestId } });

  return {
    /** To find accounts. The console uses this, not the full list, which records a read of each. */
    directory: (token: string, query: UserQuery = {}) =>
      unwrap(users.GET("/admin/directory", { params: { query }, headers: bearer(token) })),
    /** Opening another user's account is recorded as an admin read (ADR 0008). */
    getUser: (token: string, userId: string) =>
      unwrap(users.GET("/admin/users/{userId}", { params: user(userId), headers: bearer(token) })),
    suspend: (token: string, userId: string, reason: string) =>
      unwrap(
        users.POST("/admin/users/{userId}/suspend", {
          params: user(userId),
          body: { reason },
          headers: bearer(token),
        }),
      ),
    reactivate: (token: string, userId: string, reason: string) =>
      unwrap(
        users.POST("/admin/users/{userId}/reactivate", {
          params: user(userId),
          body: { reason },
          headers: bearer(token),
        }),
      ),
    /** `202` means another administrator must approve it; `200`, that it applied (or had nothing to do). */
    async changeRole(token: string, userId: string, role: Role, reason: string): Promise<RoleChange> {
      const body = await unwrap(
        users.PUT("/admin/users/{userId}/role", {
          params: user(userId),
          body: { role, reason },
          headers: bearer(token),
        }),
      );
      return "request" in body
        ? { kind: "pending", request: body.request }
        : { kind: "applied", user: body };
    },
    roleRequests: (token: string, query: Paging & { status?: RoleRequestStatus } = {}) =>
      unwrap(users.GET("/admin/role-requests", { params: { query }, headers: bearer(token) })),
    approve: (token: string, requestId: string, reason: string) =>
      unwrap(
        users.POST("/admin/role-requests/{requestId}/approve", {
          params: request(requestId),
          body: { reason },
          headers: bearer(token),
        }),
      ),
    /** Rejects a request, or withdraws one's own. */
    reject: (token: string, requestId: string, reason: string) =>
      unwrap(
        users.POST("/admin/role-requests/{requestId}/reject", {
          params: request(requestId),
          body: { reason },
          headers: bearer(token),
        }),
      ),
    audit: (token: string, query: AuditQuery = {}) =>
      unwrap(users.GET("/admin/audit-records", { params: { query }, headers: bearer(token) })),
    reads: (token: string, query: ReadsQuery = {}) =>
      unwrap(users.GET("/admin/reads", { params: { query }, headers: bearer(token) })),
    alerts: (token: string, query: Paging & { kind?: AdminAlertKind } = {}) =>
      unwrap(users.GET("/admin/alerts", { params: { query }, headers: bearer(token) })),
    /** Re-enters the password on this session, for the actions that need it (ADR 0008). */
    stepUp: (token: string, password: string) =>
      unwrap(users.POST("/auth/step-up", { body: { password }, headers: bearer(token) })),

    creditWaits: (token: string) =>
      unwrap(orders.GET("/admin/orders/pending-credit", { headers: bearer(token) })),
    reconciliation: (token: string) =>
      unwrap(orders.GET("/admin/orders/reconciliation-attempts", { headers: bearer(token) })),

    /** Read-only; the Credit Service records every admin read of a wallet or ledger. */
    wallet: (token: string, userId: string) =>
      unwrap(credit.GET("/admin/wallets/{userId}", { params: user(userId), headers: bearer(token) })),
    ledger: (token: string, userId: string, cursor?: string) =>
      unwrap(
        credit.GET("/admin/wallets/{userId}/ledger", {
          params: { ...user(userId), query: { limit: LEDGER_PAGE, cursor } },
          headers: bearer(token),
        }),
      ),
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;

export const adminApi = createAdminApi({
  userUrl: USER_SERVICE_URL,
  orderUrl: ORDER_SERVICE_URL,
  creditUrl: CREDIT_SERVICE_URL,
});
