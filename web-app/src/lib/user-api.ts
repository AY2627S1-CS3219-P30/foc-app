// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-11-05
// Scope: Generated the initial implementation for "account screens on the real User Service"
//   (USR-05, #193, WEB-00); later bug fixes and new features.
// Author review: Anselm Long, Patrick Thomas and Jonus Ho reviewed the implementation for
//   correctness, ran it against the test suite, and checked that it fits our service boundaries
//   without fatal errors before committing.

/**
 * The User Service, as the browser sees it (contracts/user-service.openapi.yaml).
 *
 * `credentials: "include"` lets the browser send and receive the `foc_refresh` cookie, which is
 * HttpOnly and scoped to `/auth` — page code can never read it. The access token is passed in by the
 * caller and lives in memory only (see session.ts).
 */

import { bearer, correlation, createApiClient, serviceUrl, unwrap, type Send } from "./api-client";
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

type Schemas = components["schemas"];

export type Role = Schemas["Role"];
export type AccountStatus = Schemas["AccountStatus"];
export type PreferredMode = Schemas["PreferredMode"];
export type ContactPreference = Schemas["ContactPreference"];
export type Profile = Schemas["Profile"];
export type Me = Schemas["Me"];
export type TokenResponse = Schemas["TokenResponse"];

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
  const api = createApiClient<paths>(baseUrl, {
    fetch,
    timeoutMs,
    notConfiguredMessage: NOT_CONFIGURED_MESSAGE,
    credentials: "include",
    // Always JSON: the auth endpoints refuse anything else as a CSRF defence.
    headers: { "content-type": "application/json" },
  });

  // Each call takes the correlation ID of the user action it belongs to, if any (PLT-04).
  const as = (id?: string) => ({ headers: correlation(id) });
  const authedAs = (token: string, id?: string) => ({
    headers: { ...bearer(token), ...correlation(id) },
  });

  return {
    register: (body: Schemas["RegisterRequest"], id?: string) =>
      unwrap(api.POST("/auth/register", { body, ...as(id) })),
    /**
     * Sets the password the student chose and activates the account (#309). A replay of a used link
     * answers `alreadyActivated` and leaves the password as it was. Does not sign in.
     */
    activate: (token: string, password: string, id?: string) =>
      unwrap(api.POST("/auth/activate", { body: { token, password }, ...as(id) })),
    /** Answers the same whether or not the address has an account waiting for activation. */
    resendActivation: (email: string, id?: string) =>
      unwrap(api.POST("/auth/activation/resend", { body: { email }, ...as(id) })),
    /** Answers the same whether or not the address has an account (#309). */
    requestPasswordReset: (email: string, id?: string) =>
      unwrap(api.POST("/auth/password-reset", { body: { email }, ...as(id) })),
    /** Sets the password from an emailed reset link, and activates a pending account. Does not sign in. */
    confirmPasswordReset: (token: string, password: string, id?: string) =>
      unwrap(api.POST("/auth/password-reset/confirm", { body: { token, password }, ...as(id) })),
    login: (email: string, password: string, id?: string) =>
      unwrap(api.POST("/auth/login", { body: { email, password }, ...as(id) })),
    refresh: (id?: string) => unwrap(api.POST("/auth/refresh", as(id))),
    logout: (id?: string) => unwrap(api.POST("/auth/logout", as(id))),
    changePassword: (body: Schemas["ChangePasswordRequest"], id?: string) =>
      unwrap(api.POST("/auth/password", { body, ...as(id) })),
    me: (token: string, id?: string) => unwrap(api.GET("/users/me", authedAs(token, id))),
    updateMe: (token: string, body: Schemas["ProfileUpdate"], id?: string) =>
      unwrap(api.PATCH("/users/me", { ...authedAs(token, id), body })),
  };
}

export type UserApi = ReturnType<typeof createUserApi>;

export const userApi = createUserApi({ baseUrl: USER_SERVICE_URL });
