import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, jwtVerify, SignJWT, type JWK } from 'jose';

export const JWT = Symbol('JWT');

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ISSUER = 'foc-user-service';

export interface AccessClaims {
  /** The user id. */
  sub: string;
  /** The refresh-session id this token was issued under. */
  sid: string;
}

/**
 * Signs and verifies access tokens (Ed25519, so other services verify with the
 * public JWKS and never hold a secret). Claims are `sub`, `sid`, `iat`, `exp`
 * and `jti` only — role and status are deliberately absent so a suspension is
 * not hidden behind a token that is valid for another 15 minutes.
 */
export class JwtService {
  private constructor(
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
    readonly publicJwk: JWK & { kid: string },
  ) {}

  static async create(base64Pem: string | undefined, allowEphemeral: boolean): Promise<JwtService> {
    let privateKey: KeyObject;
    if (base64Pem) {
      privateKey = createPrivateKey(Buffer.from(base64Pem, 'base64').toString('utf8'));
      if (privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error(
          'JWT_PRIVATE_KEY must be an Ed25519 private key (PKCS#8 PEM, base64-encoded).',
        );
      }
    } else if (allowEphemeral) {
      privateKey = generateKeyPairSync('ed25519').privateKey;
    } else {
      throw new Error('JWT_PRIVATE_KEY is required in production.');
    }
    const publicKey = createPublicKey(privateKey);
    const jwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(jwk);
    return new JwtService(privateKey, publicKey, { ...jwk, kid, alg: 'EdDSA', use: 'sig' });
  }

  sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({ sid: claims.sid })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.publicJwk.kid })
      .setIssuer(ISSUER)
      .setSubject(claims.sub)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.privateKey);
  }

  /** Throws if the signature, issuer, algorithm or expiry is wrong. */
  async verify(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      algorithms: ['EdDSA'],
      issuer: ISSUER,
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new Error('token is missing sub or sid');
    }
    return { sub: payload.sub, sid: payload.sid };
  }

  jwks(): { keys: JWK[] } {
    return { keys: [this.publicJwk] };
  }
}
