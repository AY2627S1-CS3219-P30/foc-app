// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-11-05 to 2026-11-07
// Scope: Generated the initial implementation for "set the password at activation" (USR-12, #309);
//   later tooling and boilerplate.
// Author review: Anselm Long and Jonus Ho reviewed the implementation for correctness, ran it
//   against the test suite, and checked that it fits our service boundaries without fatal errors
//   before committing.

import { randomUUID } from 'node:crypto';
import { EVENTS } from '@foc/platform';
import type { Database } from '../db/db.js';
import { usersRepository as users, type AccountStatus } from '../users/users.repository.js';
import { sessionsRepository as sessions } from './sessions.repository.js';

/**
 * #309 — what an emailed link does once it has proven the inbox, for activation and password reset
 * alike. Runs in the caller's transaction, after the caller has locked the account, claimed its
 * token and refused a suspended account:
 * - the password the inbox's owner chose becomes the account's;
 * - a pending account is activated, with its one `user.activated`;
 * - nothing set up before the proof survives: unused activation and reset links are deleted and
 *   every session is revoked.
 *
 * The password is set before the account is activated: an active account must have one. The service
 * enforces this until a later release adds the CHECK (see migration 0007).
 */
export async function setPasswordFromEmailedLink(
  tx: Database,
  account: { userId: string; status: AccountStatus; passwordHash: string; correlationId: string },
): Promise<void> {
  const { userId, correlationId } = account;
  await users.setPassword(tx, userId, account.passwordHash);
  if (account.status === 'PENDING_ACTIVATION' && (await users.markActivated(tx, userId))) {
    await users.insertOutboxEvent(tx, {
      id: randomUUID(),
      eventType: EVENTS.USER_ACTIVATED,
      aggregateId: userId,
      payload: { userId, activatedAt: new Date().toISOString() },
      correlationId,
    });
  }
  await users.deleteUnconsumedActivationTokens(tx, userId);
  await users.deleteUnconsumedPasswordResetTokens(tx, userId);
  await sessions.revokeAllForUser(tx, userId);
}
