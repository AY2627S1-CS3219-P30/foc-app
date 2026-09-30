/**
 * The User Service, as the browser sees it (contracts/user-service.openapi.yaml).
 *
 * `credentials: "include"` lets the browser send and receive the `foc_refresh` cookie, which is
 * HttpOnly and scoped to `/auth` — page code can never read it. The access token is passed in by the
 * caller and lives in memory only (see session.ts).
 */

import { bearer, createApiClient, serviceUrl, unwrap, type Send } from "./api-client";
import type { components, paths } from "./generated/user-service";

export { ApiError, toApiError, type FieldError } from "./api-client";

/** Every call fails with {@link NOT_CONFIGURED_MESSAGE}, which the screens show, when this is `null`. */
export const USER_SERVICE_URL = serviceUrl(
  process.env.NEXT_PUBLIC_USER_SERVICE_URL,
  "http://localhost:3001",
);

export const NOT_CONFIGURED_MESSAGE =
  "Accounts are unavailable: this build of the app was made without the account service's address " +
  "(NEXT_PUBLIC_USER_SERVICE_URL). Rebuild it with that set.";

/**
 * The development mailbox (`GET /dev/mailbox`) is how a local demo "receives" the activation email.
 * Only a development build asks for it, or one opted in with NEXT_PUBLIC_DEV_MAILBOX=true (the
 * Compose stack, whose User Service always runs in development mode).
 */
export const DEV_MAILBOX_ENABLED =
  process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_DEV_MAILBOX === "true";

type Schemas = components["schemas"];

export type Role = Schemas["Role"];
export type AccountStatus = Schemas["AccountStatus"];
export type PreferredMode = Schemas["PreferredMode"];
export type ContactPreference = Schemas["ContactPreference"];
export type Profile = Schemas["Profile"];
export type Me = Schemas["Me"];
export type TokenResponse = Schemas["TokenResponse"];

/** Not in the contract: the User Service mounts it only in development. */
type DevMailboxPath = {
  "/dev/mailbox": {
    get: {
      parameters: { query: { to: string } };
      responses: {
        200: {
          content: { "application/json": { to: string; token: string } | { message: string } };
        };
      };
    };
  };
};

/**
 * Builds the client. The app uses {@link userApi}; tests pass their own `fetch` (and a short timeout)
 * to drive the session logic without a server.
 */
export function createUserApi({
  baseUrl,
  fetch,
  timeoutMs,
}: {
  baseUrl: string | null;
  fetch?: Send;
  timeoutMs?: number;
}) {
  const api = createApiClient<paths & DevMailboxPath>(baseUrl, {
    fetch,
    timeoutMs,
    notConfiguredMessage: NOT_CONFIGURED_MESSAGE,
    credentials: "include",
    // Always JSON: the auth endpoints refuse anything else as a CSRF defence.
    headers: { "content-type": "application/json" },
  });

  return {
    register: (body: Schemas["RegisterRequest"]) => unwrap(api.POST("/auth/register", { body })),
    activate: (token: string) => unwrap(api.POST("/auth/activate", { body: { token } })),
    login: (email: string, password: string) =>
      unwrap(api.POST("/auth/login", { body: { email, password } })),
    refresh: () => unwrap(api.POST("/auth/refresh")),
    logout: () => unwrap(api.POST("/auth/logout")),
    changePassword: (body: Schemas["ChangePasswordRequest"]) =>
      unwrap(api.POST("/auth/password", { body })),
    me: (token: string) => unwrap(api.GET("/users/me", { headers: bearer(token) })),
    updateMe: (token: string, body: Schemas["ProfileUpdate"]) =>
      unwrap(api.PATCH("/users/me", { headers: bearer(token), body })),
    /**
     * The activation token the service would have emailed. Call it only when
     * {@link DEV_MAILBOX_ENABLED}: the User Service does not mount it in production.
     */
    devMailbox: (email: string) =>
      unwrap(api.GET("/dev/mailbox", { params: { query: { to: email } } })),
  };
}

export type UserApi = ReturnType<typeof createUserApi>;

export const userApi = createUserApi({ baseUrl: USER_SERVICE_URL });
