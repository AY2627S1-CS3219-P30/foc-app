import { createHash } from 'node:crypto';

/**
 * A deterministic UUIDv5 (RFC 4122): the same namespace + name always yields the
 * same UUID. The seed derives each supplier's id from its natural key so three
 * seed runs produce identical identifiers — no `crypto.randomUUID()`, which would
 * mint a new id every run and defeat the insert-if-absent guarantee.
 */
export function uuidv5(name: string, namespace: string): string {
  const hash = createHash('sha1');
  hash.update(namespaceToBytes(namespace));
  hash.update(Buffer.from(name, 'utf8'));
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function namespaceToBytes(namespace: string): Buffer {
  const hex = namespace.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`Not a UUID namespace: ${namespace}`);
  return Buffer.from(hex, 'hex');
}
