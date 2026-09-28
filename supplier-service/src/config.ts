import { z } from 'zod';
import { authConfigFromEnv, authEnvSchema } from '@foc/auth-client';
import { loadEnv } from '@foc/platform';

/**
 * The Supplier Service's own required variables, on top of the shared base and
 * the two `@foc/auth-client` needs to resolve a caller's live identity.
 *
 * Nothing here has a default: a missing value must stop the service at boot
 * rather than silently fall back to something insecure.
 */
export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  ...authEnvSchema,
});

/** How this service verifies callers: the User Service URL and its own `/internal/**` key. */
export const authConfig = authConfigFromEnv(env);

export const SERVICE_NAME = 'supplier-service';
export const SERVICE_VERSION = '0.1.0';
