/**
 * The User Service, as the browser sees it (contracts/user-service.openapi.yaml).
 *
 * `credentials: "include"` lets the browser send and receive the `foc_refresh` cookie, which is
 * HttpOnly and scoped to `/auth` — page code can never read it. The access token is passed in by the
 * caller and lives in memory only (see auth.tsx).
 *
 * NEXT_PUBLIC_* values are inlined at build time; without one the local Compose address is used.
 */
const BASE_URL = process.env.NEXT_PUBLIC_USER_SERVICE_URL ?? "http://localhost:3001";

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

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? "GET",
      credentials: "include",
      headers: {
        // Always JSON: the auth endpoints refuse anything else as a CSRF defence.
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, body);
  return body as T;
}

export const userApi = {
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
   * Development only: the activation token the service would have emailed. The User Service refuses
   * to boot this endpoint in production, so there it simply fails and the caller shows nothing.
   */
  devMailbox: (email: string) =>
    call<{ to: string; token: string } | { message: string }>(
      `/dev/mailbox?to=${encodeURIComponent(email)}`,
    ),
};
