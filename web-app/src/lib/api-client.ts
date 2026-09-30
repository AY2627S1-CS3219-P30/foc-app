import createClient from "openapi-fetch";
import { ApiError, toApiError } from "./user-api";

const TIMEOUT_MS = 10_000;

/** Only so a request can be built; the fetch below refuses to send it. */
const UNCONFIGURED = "http://unconfigured.invalid";

/**
 * A typed client for one service, driven by the types generated from its contract
 * (`src/lib/generated`, `bun run generate`). Paths, parameters and bodies are checked against the
 * contract at compile time. Pair each call with {@link unwrap}:
 *
 *   authed((token) => unwrap(supplierApi.GET("/suppliers", { headers: bearer(token) })))
 *
 * A `null` base URL means the build was made without the service's address.
 */
export function createApiClient<Paths extends object>(
  baseUrl: string | null,
  {
    fetch: send = (request, init) => fetch(request, init),
    timeoutMs = TIMEOUT_MS,
  }: {
    fetch?: (request: Request, init: RequestInit) => Promise<Response>;
    timeoutMs?: number;
  } = {},
) {
  return createClient<Paths>({
    baseUrl: baseUrl ?? UNCONFIGURED,
    async fetch(request) {
      if (baseUrl === null) {
        throw new ApiError(0, "NOT_CONFIGURED", "This build of the app is missing a service address.");
      }
      try {
        return await send(request, {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (err) {
        if (request.signal.aborted) throw err;
        if ((err as Error | null)?.name === "TimeoutError") {
          throw new ApiError(0, "TIMEOUT", "The server took too long to respond. Try again.");
        }
        throw new ApiError(0, "NETWORK", "Can't reach the server. Check your connection and try again.");
      }
    },
  });
}

/** The response body, or an {@link ApiError} in the shared envelope's terms. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) throw toApiError(response.status, error ?? null);
  return data as T;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
