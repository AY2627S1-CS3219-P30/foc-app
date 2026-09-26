import { z } from 'zod';

export type Role = 'STUDENT' | 'ADMIN';
export type AccountStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED';

/** The verified caller, as seen by a handler. Everything here comes from the User Service, never the client. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  displayName: string;
  roles: readonly Role[];
  status: AccountStatus;
  isAdmin: boolean;
}

export interface AuthConfig {
  /** Base URL of the User Service, e.g. `http://user-service:3001`. */
  userServiceUrl: string;
  /** This service's credential for `/internal/**`, sent as `X-Service-Key`. */
  serviceKey: string;
  /**
   * How long a session's identity may be reused before the User Service is asked again. This is
   * the **staleness window**: a suspension or logout is enforced here within at most this long.
   * Default 5000 ms. Set 0 to check on every request.
   */
  cacheTtlMs?: number;
  /** Give up on the User Service after this long and fail closed. Default 2000 ms. */
  timeoutMs?: number;
  /** Upper bound on cached sessions. Default 10 000. */
  maxCacheEntries?: number;
  /** Minimum time between key refetches triggered by an unknown key id. Default 10 000 ms. */
  jwksCooldownMs?: number;
  /** Test seam: a clock. */
  now?: () => number;
  /** Test seam: a fetch implementation. */
  fetch?: typeof fetch;
}

/** The variables a service must add to its own `loadEnv({...})` call to use this package. */
export const authEnvSchema = {
  USER_SERVICE_URL: z.url(),
  INTERNAL_SERVICE_KEY: z.string().min(16, 'must be at least 16 characters'),
};

export const authConfigFromEnv = (env: {
  USER_SERVICE_URL: string;
  INTERNAL_SERVICE_KEY: string;
}): AuthConfig => ({ userServiceUrl: env.USER_SERVICE_URL, serviceKey: env.INTERNAL_SERVICE_KEY });
