import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiException, EVENTS } from '@foc/platform';
import { hashPassword } from '../auth/passwords.js';
import { sessionsRepository as sessions } from '../auth/sessions.repository.js';
import { newOpaqueToken, sha256Hex } from '../auth/tokens.js';
import { DB, type Database } from '../db/db.js';
import { MAILER, type ActivationEmail, type Mailer } from '../mail/mailer.js';
import { isAllowedDomain, normalizeEmail } from './email.js';
import { usersRepository as repo, type AccountStatus, type Role } from './users.repository.js';
import { validationFailed } from './validation.js';

export const USER_SETTINGS = Symbol('USER_SETTINGS');

export interface UserSettings {
  allowedEmailDomains: readonly string[];
  activationTokenTtlHours: number;
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
   * replaces its password and sends a new link, so a lapsed sign-up does not lock the address.
   */
  async register(input: {
    email: string;
    password: string;
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

    // Hashed before the transaction: Argon2id is deliberately slow and must not hold a DB connection.
    const passwordHash = await hashPassword(input.password);
    const token = newOpaqueToken();

    const userId = await this.db.transaction(async (tx) => {
      const id = randomUUID();
      const user = { email, passwordHash, displayName: input.displayName };
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

    // After commit, and never failing the request: the account exists either way, and
    // `POST /auth/activation/resend` is how the student gets a link that did not arrive.
    await this.sendActivation({ to: email, userId, token });
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

  /** The new token replaces any the account still holds, so only the latest link works. */
  private async issueActivationToken(tx: Database, userId: string, token: string): Promise<void> {
    await repo.deleteUnconsumedActivationTokens(tx, userId);
    await repo.insertActivationToken(tx, {
      id: randomUUID(),
      userId,
      tokenHash: sha256Hex(token),
      ttlHours: this.settings.activationTokenTtlHours,
    });
  }

  private async sendActivation(email: ActivationEmail): Promise<void> {
    try {
      await this.mailer.sendActivation(email);
    } catch (err) {
      this.logger.error({ err, userId: email.userId, msg: 'activation email not sent' });
    }
  }

  /**
   * US-FR4.1.1 — single-use, expiring, replay-idempotent. The first success
   * activates the account and writes exactly one `UserActivated` to the outbox
   * in the same transaction; a replay changes nothing and emits nothing.
   */
  async activate(
    token: string,
    correlationId: string,
  ): Promise<{ userId: string; status: 'ACTIVE'; alreadyActivated: boolean }> {
    const tokenHash = sha256Hex(token);

    return this.db.transaction(async (tx) => {
      await repo.lockUserOfToken(tx, tokenHash);
      const userId = await repo.consumeActivationToken(tx, tokenHash);

      if (userId) {
        const activated = await repo.markActivated(tx, userId);
        // Not pending any more (e.g. suspended before it activated). Throwing rolls the
        // transaction back, so the token is not left consumed by a failed activation.
        if (!activated) throw invalidToken();
        await repo.insertOutboxEvent(tx, {
          id: randomUUID(),
          eventType: EVENTS.USER_ACTIVATED,
          aggregateId: userId,
          payload: { userId, activatedAt: new Date().toISOString() },
          correlationId,
        });
        return { userId, status: 'ACTIVE' as const, alreadyActivated: false };
      }

      const known = await repo.findActivationToken(tx, tokenHash);
      if (!known) throw invalidToken();
      if (known.consumed) {
        if (await repo.isActivated(tx, known.userId)) {
          return { userId: known.userId, status: 'ACTIVE' as const, alreadyActivated: true };
        }
        throw invalidToken();
      }
      throw new ApiException(410, 'ACTIVATION_TOKEN_EXPIRED', 'This activation link has expired.');
    });
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
