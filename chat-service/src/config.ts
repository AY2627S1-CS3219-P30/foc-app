// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-30 to 2026-11-04
// Scope: Generated the initial implementation for "wire the fifth service into the stack" (NTH-11,
//   #345, NTH-02); later new features and bug fixes.
// Author review: Anselm Long and Zhang Yuan validated the behaviour and the implementation, checked
//   for fatal errors, and confirmed it does not conflict with the architecture before committing.

import { z } from 'zod';
import { authConfigFromEnv, authEnvSchema } from '@foc/auth-client';
import { loadEnv } from '@foc/platform';

/**
 * The Chat Service's own required variables, on top of the shared base and
 * the two `@foc/auth-client` needs to resolve a caller's live identity.
 *
 * Nothing that reaches another service or the database has a default: a missing value must stop
 * the service at boot rather than silently fall back to something insecure. Only the retention
 * policy has one, ADR 0012's.
 */
export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  /** The Order Service's internal port, for the lookup every request asks (ADR 0012). */
  ORDER_SERVICE_URL: z.url(),
  /** A conversation is kept this long after its errand ends; from then every route answers 404. */
  CHAT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  /** How often the cleanup deletes channels past retention. setInterval holds at most ~24.8 days. */
  CHAT_CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(2_147_483_647)
    .default(24 * 60 * 60_000),
  /** #346: `false` refuses every socket upgrade, and the chat panel keeps polling. */
  CHAT_SOCKET_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** How often an open socket's session is checked again; a revoked one closes within this. */
  // 55 s, so a check that hits the 5 s identity cache still closes a revoked session within 60 s.
  CHAT_SOCKET_RECHECK_MS: z.coerce.number().int().min(5_000).max(55_000).default(55_000),
  /** A socket that has not sent its auth frame within this long is closed. */
  CHAT_SOCKET_AUTH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
  /** How soon a cleanup run the Order Service did not answer for is tried once more. */
  CHAT_CLEANUP_RETRY_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(2_147_483_647)
    .default(5 * 60_000),
  ...authEnvSchema,
});

/** How this service verifies callers: the User Service URL and its own `/internal/**` key. */
export const authConfig = authConfigFromEnv(env);

export const SERVICE_NAME = 'chat-service';
export const SERVICE_VERSION = '0.1.0';
