import { authConfigFromEnv, authEnvSchema } from '@foc/auth-client';
import { loadEnv } from '@foc/platform';
import { z } from 'zod';

/** The longest errand period, well inside what a saved deadline can hold. */
const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * This service's required variables: the shared base, plus the two `@foc/auth-client` needs to
 * resolve a caller's live identity from the User Service (USR-07).
 *
 * Nothing here has a default: a missing value must stop the service at boot
 * rather than silently fall back to something insecure.
 */
export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  SUPPLIER_SERVICE_URL: z.url(),
  CREDIT_WAIT_TIMEOUT_MS: z.coerce.number().int().positive(),
  ACCEPTANCE_WINDOW_MS: z.coerce.number().int().positive(),
  /** An ACCEPTED order with no pickup this long after acceptance loses its courier (OS-FR6.1.3). */
  PICKUP_TIMEOUT_MS: z.coerce.number().int().positive(),
  /** After this long since pickup with no delivery, the requester may report non-delivery (OS-FR4.1.5). */
  DELIVERY_PERIOD_MS: z.coerce.number().int().positive().max(WEEK_MS),
  /** A delivered errand neither confirmed nor reported this long after delivery confirms itself (OS-FR4.1.4). */
  AUTO_CONFIRM_MS: z.coerce.number().int().positive().max(WEEK_MS),
  /**
   * How often the lifecycle scheduler looks for due timers. At most 60 s, so a rule that fell due
   * while the service was down takes effect within 60 s of it becoming ready (OS-NFR3.1.1).
   */
  LIFECYCLE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().max(60_000),
  /** Credit's base URL, for its read-only /internal/orders/{id}/credit-status (CRD-07). */
  CREDIT_SERVICE_URL: z.url(),
  /** How often the reconciliation job looks for workflows stuck waiting on Credit. */
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive(),
  /** The least time between two repair attempts for the same order. */
  RECONCILE_RETRY_MS: z.coerce.number().int().positive(),
  ...authEnvSchema,
});

/** How this service verifies callers: the User Service URL and its own `/internal/**` key. */
export const authConfig = authConfigFromEnv(env);

export const SERVICE_NAME = 'order-service';
export const SERVICE_VERSION = '0.1.0';
