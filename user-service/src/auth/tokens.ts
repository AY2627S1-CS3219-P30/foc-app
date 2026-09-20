import { createHash, randomBytes } from 'node:crypto';

/** A 256-bit URL-safe random token. The raw value is shown to its owner once and never stored. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What we store instead of the token: a token with 256 bits of entropy needs no slow hash. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
