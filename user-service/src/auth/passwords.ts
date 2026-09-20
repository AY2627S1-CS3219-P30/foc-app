import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id with a fresh random salt per hash (US-NFR2.1.1). The encoded result
 * carries its own salt and parameters, so `verify` needs nothing else and the
 * parameters can be raised later without invalidating existing hashes.
 * Parameters follow the OWASP minimum for Argon2id (19 MiB, 2 iterations, 1 lane).
 */
const OPTIONS = { algorithm: 2 /* Argon2id */, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    return await verify(encoded, password);
  } catch {
    return false; // a malformed stored hash must never authenticate
  }
}
