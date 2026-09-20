import { z } from 'zod';
import { loadEnv } from '@foc/platform';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * The User Service's own required variables, on top of the shared base.
 *
 * Nothing security-relevant has a default: a missing value must stop the
 * service at boot rather than silently fall back to something insecure.
 */
export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  /** Registration is limited to these email domains (US-FR1.1.1). Configurable, never hard-coded. */
  ALLOWED_EMAIL_DOMAINS: z
    .string()
    .transform((v) => csv(v).map((d) => d.toLowerCase()))
    .pipe(z.array(z.string().min(1)).min(1)),
  /** Credentials other services present as `X-Service-Key` on /internal/**. One per caller. */
  INTERNAL_SERVICE_KEYS: z
    .string()
    .transform(csv)
    .pipe(z.array(z.string().min(16, 'each key must be at least 16 characters')).min(1)),
  ACTIVATION_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
});

export const SERVICE_NAME = 'user-service';
export const SERVICE_VERSION = '0.1.0';
