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
  /**
   * Base64 of an Ed25519 private key in PKCS#8 PEM form, used to sign access
   * tokens. Required in production. Outside production, if unset, a throwaway
   * key is generated at boot (tokens then stop verifying after a restart), so
   * no signing key ever needs to be committed.
   */
  JWT_PRIVATE_KEY: z.string().min(1).optional(),
  /**
   * Bootstrap administrators, created on first boot. Both must be set together.
   * The password is a bootstrap secret: put it in the secret store in production.
   */
  ADMIN_SEED_EMAILS: z
    .string()
    .transform(csv)
    .pipe(z.array(z.string().min(3)))
    .optional(),
  ADMIN_SEED_PASSWORD: z.string().min(12).max(128).optional(),
  ACTIVATION_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /**
   * Controls on administrators (ADR 0008). Defaults are the agreed policy; they are configuration so
   * an operator can tighten them without a code change.
   */
  ROLE_REQUEST_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  STEP_UP_WINDOW_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  ADMIN_SUSPENSIONS_ALERT_PER_HOUR: z.coerce.number().int().min(1).default(10),
  ADMIN_SUSPENSIONS_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(20),
  ADMIN_READS_ALERT_PER_HOUR: z.coerce.number().int().min(1).default(50),
});

export const SERVICE_NAME = 'user-service';
export const SERVICE_VERSION = '0.1.0';
