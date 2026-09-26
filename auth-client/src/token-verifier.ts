import { createRemoteJWKSet, customFetch, decodeProtectedHeader, errors, jwtVerify } from 'jose';
import { authFailure } from './errors.js';

export const ISSUER = 'foc-user-service';

/**
 * Verifies an access token's signature, algorithm, issuer and expiry against the User
 * Service's public keys. Holds no secret. Keys are fetched from the JWKS endpoint, cached,
 * and refetched (rate-limited) when a token names a key we do not have, so key rotation
 * needs no redeploy.
 */
export class TokenVerifier {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(jwksUrl: URL, options: { fetch?: typeof fetch; cooldownMs?: number } = {}) {
    const fetchImpl = options.fetch;
    this.keys = createRemoteJWKSet(jwksUrl, {
      cooldownDuration: options.cooldownMs ?? 10_000, // do not hammer the User Service over a stream of unknown kids
      cacheMaxAge: 10 * 60_000,
      timeoutDuration: 2_000,
      ...(fetchImpl ? { [customFetch]: fetchImpl } : {}),
    });
  }

  /** Returns the token's subject and session id, or throws exactly one typed failure. */
  async verify(token: string): Promise<{ sub: string; sid: string }> {
    // Malformed is decided up front so it is never confused with a bad signature.
    if (token.split('.').length !== 3) throw authFailure('TOKEN_MALFORMED');
    try {
      decodeProtectedHeader(token);
    } catch {
      throw authFailure('TOKEN_MALFORMED');
    }

    try {
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ['EdDSA'],
        issuer: ISSUER,
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw authFailure('TOKEN_INVALID');
      }
      return { sub: payload.sub, sid: payload.sid };
    } catch (err) {
      throw classify(err);
    }
  }
}

function classify(err: unknown) {
  if (err instanceof Error && 'code' in err && 'status' in err) return err; // already an ApiException
  if (err instanceof errors.JWTExpired) return authFailure('TOKEN_EXPIRED');
  if (err instanceof errors.JWSInvalid || err instanceof errors.JWTInvalid) {
    return authFailure('TOKEN_MALFORMED');
  }
  if (
    err instanceof errors.JWSSignatureVerificationFailed ||
    err instanceof errors.JWKSNoMatchingKey ||
    err instanceof errors.JWTClaimValidationFailed ||
    err instanceof errors.JOSEAlgNotAllowed ||
    err instanceof errors.JWKSMultipleMatchingKeys
  ) {
    return authFailure('TOKEN_INVALID');
  }
  // Anything else — a JWKS timeout, a network error, a bad JWKS response — means we could not
  // check, which is not the caller's fault. Fail closed as 503, never as "your token is bad".
  return authFailure('IDENTITY_UNAVAILABLE');
}
