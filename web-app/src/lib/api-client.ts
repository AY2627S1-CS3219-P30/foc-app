import createClient, { type ClientOptions } from "openapi-fetch";

/**
 * A call that takes longer than this, reading the body included, fails as TIMEOUT. Refresh runs
 * under a cross-tab lock, so without a limit one hung request would freeze every open tab.
 */
const TIMEOUT_MS = 10_000;

/** Only so a request can be built; the fetch below refuses to send it. */
const UNCONFIGURED = "http://unconfigured.invalid";

/** The header every service logs a request under, and passes on to the services it calls. */
export const CORRELATION_HEADER = "x-correlation-id";

/**
 * A fresh ID for one request. `crypto.randomUUID` exists only on secure origins (HTTPS or
 * localhost), and a demo served over plain HTTP on a LAN address must still work, so it falls back
 * to random bytes, which every origin has.
 */
export function newCorrelationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The header that puts one call in a user action (PLT-04). Give every call an action makes the same
 * ID — `const id = newCorrelationId()` once, then `correlation(id)` on each — and the services log
 * them all under it. A call made without one gets an ID of its own when it is sent.
 */
export const correlation = (id?: string): Record<string, string> =>
  id ? { [CORRELATION_HEADER]: id } : {};

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

const timedOut = () =>
  new ApiError(0, "TIMEOUT", "The server took too long to respond. Try again.");

const unreachable = () =>
  new ApiError(0, "NETWORK", "Can't reach the server. Check your connection and try again.");

/**
 * Where a service is. NEXT_PUBLIC_* values are inlined when the app is **built**, so this is fixed by
 * then (the Docker image takes it as a build arg). Outside production a missing value means the local
 * Compose address. A production build without one gets `null`, and every call to the service then
 * fails as NOT_CONFIGURED instead of quietly calling a localhost that is not there.
 */
export function serviceUrl(configured: string | undefined, localDefault: string): string | null {
  return configured || (process.env.NODE_ENV === "production" ? null : localDefault);
}

export type Send = (request: Request, init: RequestInit) => Promise<Response>;

/**
 * A typed client for one service, driven by the types generated from its contract
 * (`src/lib/generated`, `bun run generate`). Paths, parameters and bodies are checked against the
 * contract at compile time. Pair each call with {@link unwrap}:
 *
 *   authed((token) => unwrap(supplierApi.GET("/suppliers", { headers: bearer(token) })))
 *
 * A `null` base URL means the build was made without the service's address (see {@link serviceUrl}).
 * Tests pass their own `fetch` (and a short timeout) to run without a server.
 */
export function createApiClient<Paths extends object>(
  baseUrl: string | null,
  {
    fetch: send = (request, init) => fetch(request, init),
    timeoutMs = TIMEOUT_MS,
    notConfiguredMessage = "This build of the app is missing a service address.",
    ...options
  }: Pick<ClientOptions, "credentials" | "headers"> & {
    fetch?: Send;
    timeoutMs?: number;
    notConfiguredMessage?: string;
  } = {},
) {
  return createClient<Paths>({
    ...options,
    baseUrl: baseUrl ?? UNCONFIGURED,
    async fetch(request) {
      if (baseUrl === null) throw new ApiError(0, "NOT_CONFIGURED", notConfiguredMessage);
      // Sent from here, so the browser knows the ID before the response arrives and every service
      // the request reaches logs it under the same one (PLT-04).
      if (!request.headers.has(CORRELATION_HEADER)) {
        request.headers.set(CORRELATION_HEADER, newCorrelationId());
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        const response = await send(request, { signal: either(request.signal, timeout) });
        // Read here, under the timeout, so a body that hangs or is cut off fails like the request.
        const body = await response.text();
        return new Response(body || null, response);
      } catch (err) {
        if (request.signal.aborted) throw err;
        throw timeout.aborted ? timedOut() : unreachable();
      }
    },
  });
}

/** Aborts when either signal does. `AbortSignal.any` would, but Safari only has it from 17.4. */
function either(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  for (const signal of [a, b]) {
    if (signal.aborted) controller.abort(signal.reason);
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
      signal: controller.signal,
    });
  }
  return controller.signal;
}

/**
 * The response body, or an {@link ApiError} in the shared envelope's terms. A 2xx whose body is
 * missing or not JSON (a proxy's error page, say) did not come from the service: that is NETWORK.
 */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call.catch((err: unknown) => {
    throw err instanceof SyntaxError ? unreachable() : err;
  });
  if (!response.ok) throw toApiError(response.status, error ?? null);
  if (data === undefined && response.status !== 204) throw unreachable();
  return data as T;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
