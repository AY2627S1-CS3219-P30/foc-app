import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/passwords.js';
import type { Db } from '../db/db.js';
import { isAllowedDomain, normalizeEmail } from '../users/email.js';
import { usersRepository } from '../users/users.repository.js';
import { adminRepository } from './admin.repository.js';

export interface SeedResult {
  created: string[];
  skipped: string[];
}

/**
 * Creates the bootstrap administrators (US-FR3.1.3). Run at boot, idempotent, and
 * the only way an administrator comes into being without another administrator.
 *
 * An address that already has an account is skipped, never promoted: silently
 * escalating an existing student because of a config line would be a privilege
 * grant nobody approved. Each account gets its own salt. The password is a
 * bootstrap secret: it is never logged or audited, and it cannot start a session —
 * the account must replace it at first sign-in (`POST /auth/password`).
 *
 * Each account created is audited with the SYSTEM as actor, in the same
 * transaction as the account, so a bootstrap admin cannot exist without its record.
 */
export async function seedAdmins(
  db: Db,
  config: { emails?: string[]; password?: string; allowedDomains: readonly string[] },
): Promise<SeedResult> {
  const result: SeedResult = { created: [], skipped: [] };
  const emails = config.emails ?? [];
  if (emails.length === 0) return result;
  if (!config.password) {
    throw new Error('ADMIN_SEED_EMAILS is set but ADMIN_SEED_PASSWORD is not.');
  }

  for (const [index, raw] of emails.entries()) {
    const email = normalizeEmail(raw);
    if (!isAllowedDomain(email, config.allowedDomains)) {
      // Named by position, not value: this message is printed at boot, and logs never carry an
      // email address (US-NFR4.1.1).
      throw new Error(
        `ADMIN_SEED_EMAILS entry ${index + 1} is outside ALLOWED_EMAIL_DOMAINS: fix that address.`,
      );
    }
    const passwordHash = await hashPassword(config.password);
    const id = randomUUID();
    const created = await db.transaction(async (tx) => {
      const inserted = await adminRepository.insertSeededAdmin(tx, {
        id,
        email,
        passwordHash,
        displayName: 'Administrator',
      });
      if (inserted) {
        // Audited like every other role change, with the SYSTEM as actor. The reason names
        // where the grant came from; the secret is never recorded.
        await adminRepository.insertAudit(tx, {
          id: randomUUID(),
          actorId: null,
          targetUserId: id,
          action: 'ADMIN_BOOTSTRAP',
          reason: 'Bootstrap administrator from deployment configuration (ADMIN_SEED_EMAILS)',
          correlationId: 'seed',
        });
        // A seeded admin is a student too, so Credit Service must issue a wallet like any other.
        await usersRepository.insertOutboxEvent(tx, {
          id: randomUUID(),
          eventType: 'UserActivated',
          aggregateId: id,
          payload: { userId: id },
          correlationId: 'seed',
        });
      }
      return inserted;
    });
    (created ? result.created : result.skipped).push(email);
  }
  return result;
}
