// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5, Claude Sonnet 5), dates: 2026-09-21 to 2026-09-30
// Scope: Generated the initial implementation for "shared auth middleware for the other services"
//   (USR-06, USR-07); later new features and bug fixes.
// Author review: Anselm Long and Jonus Ho checked the code for correctness against the ticket,
//   confirmed the tests pass, and made sure it caused no fatal errors or architectural conflicts
//   before committing.

export { createAuthenticator, type Authenticator } from './authenticator.js';
export { authFailure, type AuthFailure } from './errors.js';
export { DEFAULT_CACHE_TTL_MS, IdentityClient, type Introspection } from './identity-client.js';
export { ISSUER, TokenVerifier } from './token-verifier.js';
export {
  authConfigFromEnv,
  authEnvSchema,
  type AccountStatus,
  type AuthConfig,
  type AuthContext,
  type Role,
} from './types.js';
export {
  AdminOnly,
  AdminOnlyGuard,
  AuthGuard,
  AuthModule,
  Authenticated,
  CurrentUser,
  AUTHENTICATOR,
  type AuthedRequest,
} from './nest.js';
export {
  authStatusEvents,
  IDENTITY_CHANGE_EVENTS,
  UserStatusInvalidation,
} from './status-events.js';
