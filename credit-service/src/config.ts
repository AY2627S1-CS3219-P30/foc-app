import { authConfigFromEnv, authEnvSchema } from '@foc/auth-client';
import { loadEnv } from '@foc/platform';
import { z } from 'zod';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * This service's required variables: the shared base, plus the two `@foc/auth-client` needs to
 * resolve a caller's live identity from the User Service (USR-07).
 *
 * Nothing here has a default: a missing value must stop the service at boot
 * rather than silently fall back to something insecure.
 */
export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  ...authEnvSchema,
  /** Credentials trusted on Credit's read-only /internal/** surface. */
  INTERNAL_SERVICE_KEYS: z
    .string()
    .transform(csv)
    .pipe(z.array(z.string().min(16, 'each key must be at least 16 characters')).min(1)),
});

/** How this service verifies callers: the User Service URL and its own `/internal/**` key. */
export const authConfig = authConfigFromEnv(env);

export const SERVICE_NAME = 'credit-service';
export const SERVICE_VERSION = '0.1.0';
