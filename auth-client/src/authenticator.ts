import { authFailure } from './errors.js';
import { IdentityClient } from './identity-client.js';
import { TokenVerifier } from './token-verifier.js';
import type { AuthConfig, AuthContext } from './types.js';

export interface Authenticator {
  /** Turns an `Authorization` header into a verified caller, or throws one typed failure. */
  authenticate(authorizationHeader: string | undefined): Promise<AuthContext>;
  /** Throws `FORBIDDEN` unless the caller is an administrator. */
  requireAdmin(context: AuthContext): void;
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
    async authenticate(header) {
      const token = bearerToken(header);
      const { sub, sid } = await verifier.verify(token);

      const who = await identity.introspect(sid, sub);
      if (!who.active) throw authFailure('TOKEN_REVOKED');
      if (who.status === 'SUSPENDED') throw authFailure('ACCOUNT_SUSPENDED');
      if (who.status !== 'ACTIVE') throw authFailure('ACCOUNT_NOT_ACTIVATED');

      return {
        userId: who.userId,
        sessionId: sid,
        displayName: who.displayName,
        roles: who.roles,
        status: who.status,
        isAdmin: who.roles.includes('ADMIN'),
      };
    },

    requireAdmin(context) {
      if (!context.isAdmin) throw authFailure('FORBIDDEN');
    },
  };
}

function bearerToken(header: string | undefined): string {
  if (header === undefined || header.trim() === '') throw authFailure('TOKEN_MISSING');
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) throw authFailure('TOKEN_MALFORMED');
  return match[1];
}
