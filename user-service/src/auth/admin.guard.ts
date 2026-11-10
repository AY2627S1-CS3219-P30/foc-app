// AI Assistance Disclosure:
// Tool: Claude Code (Claude Sonnet 5, Claude Opus 4.8, Claude Opus 5.5), dates: 2026-09-21 to
//   2026-09-30
// Scope: Generated the initial implementation for "RBAC, profile edits and admin controls"
//   (USR-03); later tests and new features.
// Author review: Anselm Long and Patrick Thomas verified correctness, tested the change, and
//   checked for fatal errors and conflicts with our architecture before committing.

import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ApiException } from '@foc/platform';
import { DB, type Database } from '../db/db.js';
import { usersRepository } from '../users/users.repository.js';
import type { AuthedRequest } from './access-token.guard.js';

/**
 * Requires the caller to hold ADMIN. Always used *after* AccessTokenGuard, and it
 * reads the role from the database, never from anything the client sent.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    // AccessTokenGuard must run first and set `req.auth`. If it did not, the guards are
    // misordered — fail closed and say so, rather than let "no identity" happen to mean "refuse".
    if (!req.auth) throw new ApiException(401, 'UNAUTHENTICATED', 'Authentication required.');
    const identity = await usersRepository.findIdentity(this.db, req.auth.userId);
    if (!identity || identity.status !== 'ACTIVE' || !identity.roles.includes('ADMIN')) {
      throw new ApiException(403, 'FORBIDDEN', 'Administrator role required.');
    }
    return true;
  }
}
