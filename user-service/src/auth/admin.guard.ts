import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ApiException } from '@foc/platform';
import { DB, type Db } from '../db/db.js';
import { usersRepository } from '../users/users.repository.js';
import type { AuthedRequest } from './access-token.guard.js';

/**
 * Requires the caller to hold ADMIN. Always used *after* AccessTokenGuard, and it
 * reads the role from the database, never from anything the client sent.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const identity = req.auth ? await usersRepository.findIdentity(this.db, req.auth.userId) : null;
    if (!identity || identity.status !== 'ACTIVE' || !identity.roles.includes('ADMIN')) {
      throw new ApiException(403, 'FORBIDDEN', 'Administrator role required.');
    }
    return true;
  }
}
