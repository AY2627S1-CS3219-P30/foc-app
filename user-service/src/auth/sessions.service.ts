import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiException } from '@foc/platform';
import { DB, type Db } from '../db/db.js';
import { normalizeEmail } from '../users/email.js';
import { validationFailed } from '../users/validation.js';
import {
  usersRepository as users,
  type AccountStatus,
  type Role,
} from '../users/users.repository.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { ACCESS_TOKEN_TTL_SECONDS, JWT, type JwtService } from './jwt.service.js';
import { REFRESH_TTL_DAYS } from './cookies.js';
import { sessionsRepository as sessions } from './sessions.repository.js';
import { newOpaqueToken, sha256Hex } from './tokens.js';

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: { id: string; displayName: string; roles: Role[]; status: AccountStatus };
}

export const SESSION_SETTINGS = Symbol('SESSION_SETTINGS');

export interface SessionSettings {
  /** `ADMIN_SEED_PASSWORD`, if configured: a bootstrap admin may not choose it as their own. */
  bootstrapPassword?: string;
}

const codeForStatus = (status: AccountStatus) =>
  status === 'SUSPENDED'
    ? new ApiException(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.')
    : new ApiException(
        403,
        'ACCOUNT_NOT_ACTIVATED',
        'Activate your account from the email we sent.',
      );

const invalidCredentials = () =>
  new ApiException(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

const passwordChangeRequired = () =>
  new ApiException(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before signing in.');

const passwordUnchanged = (message: string) =>
  validationFailed([{ field: 'newPassword', code: 'PASSWORD_UNCHANGED', message }]);

@Injectable()
export class SessionsService {
  /** Hashed once, so an unknown email costs the same Argon2 work as a wrong password. */
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(JWT) private readonly jwt: JwtService,
    @Inject(SESSION_SETTINGS) private readonly settings: SessionSettings,
  ) {}

  /** US-FR1.1.2 — only valid credentials on an ACTIVE account get tokens. */
  async login(rawEmail: string, password: string): Promise<IssuedSession> {
    const user = await this.verifyCredentials(rawEmail, password);
    // A bootstrap password is shared deployment configuration, not a credential: it only lets
    // the account replace it (US-FR3.1.3.2). No session is started with it.
    if (user.mustChangePassword) throw passwordChangeRequired();

    const sessionId = randomUUID();
    const refreshToken = newOpaqueToken();
    const started = await sessions.insertIfLoginable(
      this.db,
      {
        id: sessionId,
        familyId: randomUUID(),
        userId: user.id,
        tokenHash: sha256Hex(refreshToken),
        ttlDays: REFRESH_TTL_DAYS,
      },
      user.passwordHash,
    );
    // The password was changed, or the account suspended, while Argon2 ran: what we verified is stale.
    if (!started) throw invalidCredentials();
    return this.respond(user.id, sessionId, refreshToken, {
      id: user.id,
      displayName: user.displayName,
      roles: user.roles,
      status: user.status,
    });
  }

  /**
   * Rotates the refresh token. Each use invalidates the presented token and
   * issues a new one in the same family. Presenting a token that was already
   * rotated means it was copied: the whole family is revoked.
   */
  async refresh(refreshToken: string | undefined): Promise<IssuedSession> {
    if (!refreshToken) throw invalid();
    const hash = sha256Hex(refreshToken);
    const nextToken = newOpaqueToken();
    const nextId = randomUUID();

    // Outcomes are returned, not thrown, from inside the transaction: a throw would
    // roll back the family revocation that reuse detection exists to perform.
    const outcome = await this.db.transaction(async (tx) => {
      const row = await sessions.lockByHash(tx, hash);
      if (!row) return { kind: 'invalid' as const };
      if (row.rotated) {
        await sessions.revokeFamily(tx, row.familyId);
        return { kind: 'reused' as const };
      }
      if (row.revoked || row.expired) return { kind: 'invalid' as const };
      if (row.userStatus !== 'ACTIVE') {
        await sessions.revokeFamily(tx, row.familyId);
        return { kind: 'inactive' as const, status: row.userStatus };
      }
      // Login never starts a session for a flagged account; one that predates migration 004, or
      // came from an instance still on older code, ends here.
      if (row.mustChangePassword) {
        await sessions.revokeFamily(tx, row.familyId);
        return { kind: 'passwordChangeRequired' as const };
      }
      await sessions.markRotated(tx, row.id);
      await sessions.insert(tx, {
        id: nextId,
        familyId: row.familyId,
        userId: row.userId,
        tokenHash: sha256Hex(nextToken),
        ttlDays: REFRESH_TTL_DAYS,
      });
      return { kind: 'ok' as const, userId: row.userId };
    });

    switch (outcome.kind) {
      case 'invalid':
        throw invalid();
      case 'reused':
        throw new ApiException(401, 'REFRESH_TOKEN_REUSED', 'Session revoked. Log in again.');
      case 'inactive':
        throw codeForStatus(outcome.status);
      case 'passwordChangeRequired':
        throw passwordChangeRequired();
      case 'ok': {
        const identity = await users.findIdentity(this.db, outcome.userId);
        if (!identity) throw invalid();
        return this.respond(outcome.userId, nextId, nextToken, {
          id: outcome.userId,
          displayName: identity.displayName,
          roles: identity.roles,
          status: identity.status,
        });
      }
    }
  }

  /**
   * Replaces a password after proving the current one. Proof is the password itself rather than
   * an access token, so the same call serves a bootstrap admin who has no session yet (their login
   * is refused with `PASSWORD_CHANGE_REQUIRED`) and any active user changing theirs.
   *
   * Every session of the account is revoked in the same transaction: whoever knew the old password
   * may already hold one. Failure responses match login's, so this is no better an oracle than it.
   */
  async changePassword(rawEmail: string, currentPassword: string, newPassword: string) {
    const user = await this.verifyCredentials(rawEmail, currentPassword);
    if (newPassword === currentPassword) {
      throw passwordUnchanged('Choose a password different from the current one.');
    }
    // Choosing the bootstrap secret would hand the account back to everyone who knows it. Checked
    // only for a seeded admin, who knows it already: for anyone else it would confirm a guess.
    if (user.isSeededAdmin && newPassword === this.settings.bootstrapPassword) {
      throw passwordUnchanged('Choose a password different from the bootstrap password.');
    }

    // Hashed before the transaction: Argon2id is deliberately slow and must not hold a connection.
    const newHash = await hashPassword(newPassword);
    const replaced = await this.db.transaction(async (tx) => {
      if (!(await users.replacePassword(tx, user.id, user.passwordHash, newHash))) return false;
      await sessions.revokeAllForUser(tx, user.id);
      return true;
    });
    // Lost a race with another change: the password we verified is no longer the current one.
    if (!replaced) throw invalidCredentials();
  }

  /** Revokes the caller's whole session family. Idempotent: an unknown or absent token is a no-op. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await sessions.revokeFamilyByTokenHash(this.db, sha256Hex(refreshToken));
  }

  /**
   * The credential check login and password change share. An unknown email costs the same Argon2
   * work as a wrong password and gets the same answer; the account's status is revealed only after
   * the password proves the caller owns it.
   */
  private async verifyCredentials(rawEmail: string, password: string) {
    const user = await users.findCredentials(this.db, normalizeEmail(rawEmail));

    this.dummyHash ??= hashPassword('not-a-real-password');
    // Verify against a dummy hash when the email is unknown so response time does not reveal it.
    const valid = await verifyPassword(user?.passwordHash ?? (await this.dummyHash), password);
    if (!user || !valid) throw invalidCredentials();
    if (user.status !== 'ACTIVE') throw codeForStatus(user.status);
    return user;
  }

  private async respond(
    userId: string,
    sessionId: string,
    refreshToken: string,
    user: IssuedSession['user'],
  ): Promise<IssuedSession> {
    return {
      accessToken: await this.jwt.sign({ sub: userId, sid: sessionId }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user,
    };
  }
}

function invalid(): ApiException {
  return new ApiException(401, 'REFRESH_TOKEN_INVALID', 'Session expired. Log in again.');
}
