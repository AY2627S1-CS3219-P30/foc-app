import { randomUUID } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import { EVENTS } from '@foc/platform';
import { hashPassword } from '../auth/passwords.js';
import type { Db } from '../db/db.js';
import { isAllowedDomain, normalizeEmail } from '../users/email.js';
import { usersRepository } from '../users/users.repository.js';
import { adminRepository } from './admin.repository.js';

export interface SeedResult {
  created: string[];
  /**
   * `entry` is the address's 1-based position in ADMIN_SEED_EMAILS, which is how the boot log
   * names it. Positions count addresses: the config parser drops blank entries (`a,,b`).
   */
  skipped: { entry: number; email: string }[];
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
    const entry = index + 1;
    const email = normalizeEmail(raw);
    if (!isAllowedDomain(email, config.allowedDomains)) {
      // Named by position and domain, never by address: this message is printed at boot, and
      // logs never carry an email address (US-NFR4.1.1). The domain is the actual mistake.
      const at = email.lastIndexOf('@');
      const problem =
        at < 1
          ? 'is not an email address'
          : `has domain ${email.slice(at + 1)}, which is not in ALLOWED_EMAIL_DOMAINS`;
      throw new Error(`ADMIN_SEED_EMAILS address ${entry} of ${emails.length} ${problem}.`);
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
          eventType: EVENTS.USER_ACTIVATED,
          aggregateId: id,
          payload: { userId: id, activatedAt: new Date().toISOString() },
          correlationId: 'seed',
        });
      }
      return inserted;
    });
    if (created) result.created.push(email);
    else result.skipped.push({ entry, email });
  }
  return result;
}

/**
 * The boot log of a seed run: counts and positions, never an address (US-NFR4.1.1). Who was
 * bootstrapped is in the audit trail (ADMIN_BOOTSTRAP rows), which is where an operator looks.
 */
export function reportSeed(logger: Pick<LoggerService, 'log' | 'warn'>, result: SeedResult): void {
  const total = result.created.length + result.skipped.length;
  if (total === 0) {
    logger.warn('No seeded administrators configured.');
    return;
  }
  if (result.created.length > 0) logger.log(`Seeded administrators: ${result.created.length}`);
  if (result.skipped.length > 0) {
    const entries = result.skipped.map((s) => s.entry).join(', ');
    logger.warn(
      `Seed skipped ADMIN_SEED_EMAILS address(es) ${entries} of ${total}: ` +
        'an account already exists and is never promoted',
    );
  }
}
