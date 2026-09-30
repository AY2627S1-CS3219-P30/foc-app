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
