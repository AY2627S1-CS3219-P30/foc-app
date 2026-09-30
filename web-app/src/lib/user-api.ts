/**
 * The User Service, as the browser sees it (contracts/user-service.openapi.yaml).
 *
 * `credentials: "include"` lets the browser send and receive the `foc_refresh` cookie, which is
 * HttpOnly and scoped to `/auth` — page code can never read it. The access token is passed in by the
 * caller and lives in memory only (see session.ts).
 */

/**
 * Where the User Service is. NEXT_PUBLIC_* values are inlined when the app is **built**, so this is
 * fixed by then (the Docker image takes it as a build arg). Outside production a missing value means
 * the local Compose address. A production build without one gets `null`: every call then fails with
 * {@link NOT_CONFIGURED_MESSAGE}, which the screens show, instead of quietly calling a localhost that
 * is not there.
 */
export const USER_SERVICE_URL: string | null =
  process.env.NEXT_PUBLIC_USER_SERVICE_URL ||
  (process.env.NODE_ENV === "production" ? null : "http://localhost:3001");

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

/**
 * A call that takes longer than this fails as unreachable. Refresh runs under a cross-tab lock, so
 * without a limit one hung request would freeze every open tab.
 */
const TIMEOUT_MS = 10_000;

export type Role = "STUDENT" | "ADMIN";
export type AccountStatus = "PENDING_ACTIVATION" | "ACTIVE" | "SUSPENDED";
export type PreferredMode = "REQUESTER" | "COURIER";
export type ContactPreference = "IN_APP" | "EMAIL";

export type Profile = {
  displayName: string;
  faculty: string | null;
  avatarRef: string | null;
  contactPreference: ContactPreference;
  preferredMode: PreferredMode;
};

export type Me = {
  id: string;
  email: string;
  roles: Role[];
  status: AccountStatus;
  profile: Profile;
  createdAt: string;
};

export type TokenResponse = {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: { id: string; displayName: string; roles: Role[]; status: AccountStatus };
};

export type FieldError = { field: string; code: string; message: string };

/** A failed call, in the shared error envelope's terms. `status` 0 means the server was unreachable. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: FieldError[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The server's message for one field, if it rejected that field. */
  fieldMessage(field: string): string | undefined {
    return this.details.find((d) => d.field === field)?.message;
  }
}

/** Turns a non-2xx response body into an {@link ApiError}, tolerating a body that is not the envelope. */
export function toApiError(status: number, body: unknown): ApiError {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : status >= 500 ? "INTERNAL" : "ERROR";
  const message =
    typeof error?.message === "string" ? error.message : "Something went wrong. Please try again.";
  const details = Array.isArray(error?.details)
    ? (error.details as unknown[]).filter(
        (d): d is FieldError =>
          !!d &&
          typeof (d as FieldError).field === "string" &&
          typeof (d as FieldError).message === "string",
      )
    : [];
  return new ApiError(status, code, message, details);
}

const unreachable = () =>
  new ApiError(0, "NETWORK", "Can't reach the server. Check your connection and try again.");

/**
 * Builds the client. The app uses {@link userApi}; tests pass their own `fetch` (and a short timeout)
 * to drive the session logic without a server.
 */
export function createUserApi({
  baseUrl,
  fetch: send = (url, init) => fetch(url, init),
  timeoutMs = TIMEOUT_MS,
}: {
  baseUrl: string | null;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}) {
  async function call<T>(
    path: string,
    init: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<T> {
    if (baseUrl === null) throw new ApiError(0, "NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE);
    let res: Response;
    try {
      res = await send(`${baseUrl}${path}`, {
        method: init.method ?? "GET",
        credentials: "include",
        headers: {
          // Always JSON: the auth endpoints refuse anything else as a CSRF defence.
          "content-type": "application/json",
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if ((err as Error | null)?.name === "TimeoutError") {
        throw new ApiError(0, "TIMEOUT", "The server took too long to respond. Try again.");
      }
      throw unreachable();
    }
    if (res.status === 204) return undefined as T;
    // `undefined` when the body is not JSON, or was cut off (the timeout covers reading it too).
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw toApiError(res.status, body ?? null);
    if (body === undefined) throw unreachable();
    return body as T;
  }

  return {
    register: (input: { email: string; password: string; displayName: string }) =>
      call<{ userId: string; status: "PENDING_ACTIVATION" }>("/auth/register", {
        method: "POST",
        body: input,
      }),
    activate: (token: string) =>
      call<{ userId: string; status: "ACTIVE"; alreadyActivated: boolean }>("/auth/activate", {
        method: "POST",
        body: { token },
      }),
    login: (email: string, password: string) =>
      call<TokenResponse>("/auth/login", { method: "POST", body: { email, password } }),
    refresh: () => call<TokenResponse>("/auth/refresh", { method: "POST", body: {} }),
    logout: () => call<void>("/auth/logout", { method: "POST", body: {} }),
    changePassword: (input: { email: string; currentPassword: string; newPassword: string }) =>
      call<void>("/auth/password", { method: "POST", body: input }),
    me: (token: string) => call<Me>("/users/me", { token }),
    updateMe: (token: string, changes: Partial<Profile>) =>
      call<Me>("/users/me", { method: "PATCH", token, body: changes }),
    /**
     * The activation token the service would have emailed. Call it only when
     * {@link DEV_MAILBOX_ENABLED}: the User Service does not mount it in production.
     */
    devMailbox: (email: string) =>
      call<{ to: string; token: string } | { message: string }>(
        `/dev/mailbox?to=${encodeURIComponent(email)}`,
      ),
  };
}

export type UserApi = ReturnType<typeof createUserApi>;

export const userApi = createUserApi({ baseUrl: USER_SERVICE_URL });
