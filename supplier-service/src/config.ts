// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5, Claude Opus 4.8), dates: 2026-09-20 to 2026-09-28
// Scope: Generated the initial implementation for "scaffold the four services on a shared runtime"
//   (SUP-01); later new features.
// Author review: Jonus Ho and Patrick Thomas checked the code for correctness against the ticket,
//   confirmed the tests pass, and made sure it caused no fatal errors or architectural conflicts
//   before committing.

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
