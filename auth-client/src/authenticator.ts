import { authFailure } from './errors.js';
import { IdentityClient } from './identity-client.js';
import { TokenVerifier } from './token-verifier.js';
import type { AuthConfig, AuthContext } from './types.js';

export interface Authenticator {
  /**
   * Turns an `Authorization` header into a verified caller, or throws one typed failure.
   * `correlationId` is the inbound request's; it travels on the call to the User Service so both
   * services log the check under one ID (PLT-04).
   */
  authenticate(
    authorizationHeader: string | undefined,
    options?: { correlationId?: string },
  ): Promise<AuthContext>;
  /** Throws `FORBIDDEN` unless the caller is an administrator. */
  requireAdmin(context: AuthContext): void;
  /**
   * Drops any cached identity for this user, so their next request is checked against the User
   * Service. Called on `user.suspended` / `user.reactivated` / `user.role-changed` (see
   * `status-events.ts`).
   */
  invalidateUser(userId: string): void;
}

/**
 * The framework-neutral core. A service never parses a token itself:
 *
 *  1. read the bearer token            → TOKEN_MISSING / TOKEN_MALFORMED
 *  2. verify signature, issuer, expiry → TOKEN_INVALID / TOKEN_EXPIRED
 *  3. ask the User Service about the session and account
 *                                      → TOKEN_REVOKED / ACCOUNT_SUSPENDED / ACCOUNT_NOT_ACTIVATED
 *  4. role and status come from step 3 only — never from the token, a header or the body.
 */
export function createAuthenticator(config: AuthConfig): Authenticator {
  const verifier = new TokenVerifier(new URL('/.well-known/jwks.json', config.userServiceUrl), {
    fetch: config.fetch,
    cooldownMs: config.jwksCooldownMs,
  });
  const identity = new IdentityClient(config);

  return {
    async authenticate(header, options) {
      const token = bearerToken(header);
      const { sub, sid } = await verifier.verify(token);

      const who = await identity.introspect(sid, sub, options?.correlationId);
      if (!who.active) throw authFailure('TOKEN_REVOKED');
      if (who.status === 'SUSPENDED') throw authFailure('ACCOUNT_SUSPENDED');
      // Anything that is not exactly ACTIVE is denied — including a status added after this was written.
      if (who.status !== 'ACTIVE') throw authFailure('ACCOUNT_NOT_ACTIVATED');

      return {
        userId: who.userId,
        sessionId: sid,
        displayName: who.displayName,
        roles: who.roles,
        status: 'ACTIVE',
        isAdmin: who.roles.includes('ADMIN'),
      };
    },

    requireAdmin(context) {
      if (!context.isAdmin) throw authFailure('FORBIDDEN');
    },

    invalidateUser(userId) {
      identity.invalidateUser(userId);
    },
  };
}

function bearerToken(header: string | undefined): string {
  if (header === undefined || header.trim() === '') throw authFailure('TOKEN_MISSING');
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) throw authFailure('TOKEN_MALFORMED');
  return match[1];
}
