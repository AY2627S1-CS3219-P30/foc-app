// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5, Claude Sonnet 5, Claude Opus 4.8), dates: 2026-09-20 to
//   2026-11-05
// Scope: Generated the initial implementation for "registration, one-time activation and identity
//   lookup" (USR-01, USR-06, USR-07); later tests and new features.
// Author review: Anselm Long, Patrick Thomas and Zhang Yuan validated the behaviour and the
//   implementation, checked for fatal errors, and confirmed it does not conflict with the
//   architecture before committing.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiException } from '@foc/platform';
import { setPasswordFromEmailedLink } from '../auth/emailed-link.js';
import { hashPassword } from '../auth/passwords.js';
import { sessionsRepository as sessions } from '../auth/sessions.repository.js';
import { newOpaqueToken, sha256Hex } from '../auth/tokens.js';
import { DB, type Database } from '../db/db.js';
import {
  MAILER,
  type ActivationEmail,
  type Mailer,
  type PasswordResetEmail,
} from '../mail/mailer.js';
import { isAllowedDomain, normalizeEmail } from './email.js';
import { usersRepository as repo, type AccountStatus, type Role } from './users.repository.js';
import { validationFailed } from './validation.js';

export const USER_SETTINGS = Symbol('USER_SETTINGS');

export interface UserSettings {
  allowedEmailDomains: readonly string[];
  activationTokenTtlMinutes: number;
  passwordResetTokenTtlMinutes: number;
}

export interface ActivationResult {
  userId: string;
  status: 'ACTIVE';
  alreadyActivated: boolean;
}

export interface IdentityLookup {
  userId: string;
  exists: boolean;
  status?: AccountStatus;
  roles?: Role[];
  displayName?: string;
}

export type IntrospectionResult =
  | { active: false }
  | {
      active: true;
      userId: string;
      status: AccountStatus;
      roles: Role[];
      displayName: string;
    };

export interface PermissionsLookup {
  userId: string;
  status: AccountStatus;
  isAdmin: boolean;
  canPlaceOrders: boolean;
  canAcceptOrders: boolean;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(USER_SETTINGS) private readonly settings: UserSettings,
  ) {}

  /**
   * US-FR1.1.1 — reject off-domain and duplicate emails without creating an account. An address
   * that never activated and whose links have all expired is not a duplicate: registering again
   * replaces its display name and sends a new link, so a lapsed sign-up does not lock the address.
   *
   * No password is taken (#309): whoever registers has not proven the inbox, so a password chosen
   * here could be anyone's. The inbox's owner chooses it at activation.
   */
  async register(input: {
    email: string;
    displayName: string;
  }): Promise<{ userId: string; status: 'PENDING_ACTIVATION' }> {
    const email = normalizeEmail(input.email);
    if (!isAllowedDomain(email, this.settings.allowedEmailDomains)) {
      throw validationFailed([
        {
          field: 'email',
          code: 'EMAIL_DOMAIN_NOT_ALLOWED',
          message: 'Use your NUS email address.',
        },
      ]);
    }

    const token = newOpaqueToken();

    const userId = await this.db.transaction(async (tx) => {
      const id = randomUUID();
      const user = { email, displayName: input.displayName };
      if (await repo.insertUser(tx, { id, ...user })) {
        await this.issueActivationToken(tx, id, token);
        return id;
      }
      const revived = await repo.reviveExpiredRegistration(tx, user);
      if (revived) await this.issueActivationToken(tx, revived, token);
      return revived;
    });

    if (!userId) {
      throw new ApiException(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'An account with this email already exists.',
      );
    }

    // After commit, in the background as resend does, so a slow relay cannot hold the answer; and
    // never failing the request: the account exists either way, and
    // `POST /auth/activation/resend` is how the student gets a link that did not arrive.
    void this.sendActivation({ to: email, userId, token });
    return { userId, status: 'PENDING_ACTIVATION' };
  }

  /**
   * Sends a new link to a pending account and invalidates the old ones. The caller learns nothing:
   * an unknown, off-domain, active or suspended address gets the same answer and no email. Never
   * throws, so the controller can answer before this finishes and timing reveals nothing either.
   */
  async resendActivation(rawEmail: string): Promise<void> {
    try {
      const email = normalizeEmail(rawEmail);
      if (!isAllowedDomain(email, this.settings.allowedEmailDomains)) return;
      const token = newOpaqueToken();
      const userId = await this.db.transaction(async (tx) => {
        const id = await repo.lockPendingUser(tx, email);
        if (id) await this.issueActivationToken(tx, id, token);
        return id;
      });
      if (userId) await this.sendActivation({ to: email, userId, token });
    } catch (err) {
      this.logger.error({ err, msg: 'activation resend failed' });
    }
  }

  /**
   * #309 — mails a password reset link to an active or pending account, invalidating its earlier
   * ones. A pending account is included on purpose: whoever registered the address chose its
   * password, and the link is how the inbox's owner replaces that choice. Like resend, the caller
   * learns nothing (an unknown or suspended address gets no email and the same answer), and this
   * never throws, so the controller answers before it finishes.
   *
   * No domain check: an address that has an account may reset it even if the allowlist has since
   * changed, and one that has none gets nothing anyway.
   */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    try {
      const email = normalizeEmail(rawEmail);
      const token = newOpaqueToken();
      const userId = await this.db.transaction(async (tx) => {
        const id = await repo.lockResettableUser(tx, email);
        if (!id) return null;
        await repo.deleteUnconsumedPasswordResetTokens(tx, id);
        await repo.insertPasswordResetToken(tx, {
          id: randomUUID(),
          userId: id,
          tokenHash: sha256Hex(token),
          ttlMinutes: this.settings.passwordResetTokenTtlMinutes,
        });
        return id;
      });
      if (userId) await this.sendPasswordReset({ to: email, userId, token });
    } catch (err) {
      this.logger.error({ err, msg: 'password reset request failed' });
    }
  }

  /** Never throws, so a caller may leave it running without an unhandled rejection. */
  private async sendPasswordReset(email: PasswordResetEmail): Promise<void> {
    try {
      await this.mailer.sendPasswordReset(email);
    } catch (err) {
      this.logger.error({ err, userId: email.userId, msg: 'password reset email not sent' });
    }
  }

  /** The new token replaces any the account still holds, so only the latest link works. */
  private async issueActivationToken(tx: Database, userId: string, token: string): Promise<void> {
    await repo.deleteUnconsumedActivationTokens(tx, userId);
    await repo.insertActivationToken(tx, {
      id: randomUUID(),
      userId,
      tokenHash: sha256Hex(token),
      ttlMinutes: this.settings.activationTokenTtlMinutes,
    });
  }

  /** Never throws, so a caller may leave it running without an unhandled rejection. */
  private async sendActivation(email: ActivationEmail): Promise<void> {
    try {
      await this.mailer.sendActivation(email);
    } catch (err) {
      this.logger.error({ err, userId: email.userId, msg: 'activation email not sent' });
    }
  }

  /**
   * US-FR4.1.1 — single-use, expiring, replay-idempotent. The first success sets the password the
   * inbox's owner chose (#309), activates the account and writes exactly one `UserActivated` to the
   * outbox in the same transaction; a replay changes nothing, the password included, and emits
   * nothing. Shares its writes with a password reset ({@link setPasswordFromEmailedLink}).
   *
   * The token is checked before Argon2 runs, so a made-up token or a replay costs one indexed read,
   * not a hash.
   */
  async activate(
    token: string,
    password: string,
    correlationId: string,
  ): Promise<ActivationResult> {
    const tokenHash = sha256Hex(token);
    const found = await repo.findActivationToken(this.db, tokenHash);
    if (!found || found.consumed || found.expired) return this.unusableToken(this.db, found);

    // Hashed before the transaction: Argon2id is deliberately slow and must not hold a connection.
    const passwordHash = await hashPassword(password);
    return this.db.transaction(async (tx) => {
      const status = await repo.lockUserOfToken(tx, tokenHash);
      const userId = await repo.consumeActivationToken(tx, tokenHash);
      // Used (a second submit) or expired while Argon2 ran: answered as a replay. Nothing was written.
      if (!userId || !status) {
        return this.unusableToken(tx, await repo.findActivationToken(tx, tokenHash));
      }
      // Not pending any more (e.g. suspended before it activated). Throwing rolls the
      // transaction back, so the token is not left consumed by a failed activation.
      if (status !== 'PENDING_ACTIVATION') throw invalidToken();

      await setPasswordFromEmailedLink(tx, { userId, status, passwordHash, correlationId });
      return { userId, status: 'ACTIVE' as const, alreadyActivated: false };
    });
  }

  /** A token that cannot activate: a replay on an active account succeeds; the rest are refused. */
  private async unusableToken(
    db: Database,
    found: { userId: string; consumed: boolean; expired: boolean } | null,
  ): Promise<ActivationResult> {
    if (!found) throw invalidToken();
    if (found.consumed) {
      if (await repo.isActivated(db, found.userId)) {
        return { userId: found.userId, status: 'ACTIVE', alreadyActivated: true };
      }
      throw invalidToken();
    }
    throw new ApiException(410, 'ACTIVATION_TOKEN_EXPIRED', 'This activation link has expired.');
  }

  /** US-FR4.1.2 — existence, status, roles and display name only. */
  async lookup(userId: string): Promise<IdentityLookup> {
    const row = await repo.findIdentity(this.db, userId);
    if (!row) return { userId, exists: false };
    return { userId, exists: true, ...row };
  }

  /**
   * Introspection for other services' auth middleware: is this session still live, and who is
   * behind it? One call answers both, so a service does not need a second lookup per request.
   * `active` is false — with nothing else revealed — when the session is revoked, expired,
   * unknown, or does not belong to `userId`. A live session for a suspended or pending
   * account is still `active`, with its `status`, so the caller can answer 403 rather than 401.
   */
  async introspect(sessionId: string, userId: string): Promise<IntrospectionResult> {
    const session = await sessions.liveness(this.db, sessionId, userId);
    if (!session?.live) return { active: false };
    const identity = await repo.findIdentity(this.db, userId);
    if (!identity) return { active: false };
    return {
      active: true,
      userId,
      status: identity.status,
      roles: identity.roles,
      displayName: identity.displayName,
    };
  }

  /** The administrators who may act now, so another service can route work to one. */
  async listActiveAdmins(): Promise<{ items: Array<{ userId: string }> }> {
    const ids = await repo.listActiveAdminIds(this.db);
    return { items: ids.map((userId) => ({ userId })) };
  }

  /** US-FR4.1.3 — a suspended or pending admin has no effective permissions. */
  async permissions(userId: string): Promise<PermissionsLookup> {
    const row = await repo.findIdentity(this.db, userId);
    if (!row) throw new ApiException(404, 'NOT_FOUND', 'User not found.');
    const active = row.status === 'ACTIVE';
    return {
      userId,
      status: row.status,
      isAdmin: active && row.roles.includes('ADMIN'),
      canPlaceOrders: active,
      canAcceptOrders: active,
    };
  }
}

function invalidToken(): ApiException {
  return new ApiException(404, 'ACTIVATION_TOKEN_INVALID', 'This activation link is not valid.');
}
