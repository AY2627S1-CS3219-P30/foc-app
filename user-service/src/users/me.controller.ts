import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { ApiException } from '@foc/platform';
import { AccessTokenGuard, type AuthedRequest } from '../auth/access-token.guard.js';
import { DB, type Db } from '../db/db.js';
import { usersRepository } from './users.repository.js';

@Controller('users/me')
@UseGuards(AccessTokenGuard)
export class MeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async me(@Req() req: AuthedRequest) {
    const u = await usersRepository.findMe(this.db, req.auth.userId);
    if (!u) throw new ApiException(401, 'UNAUTHENTICATED', 'Authentication required.');
    return {
      id: u.id,
      email: u.email,
      roles: u.roles,
      status: u.status,
      profile: {
        displayName: u.display_name,
        faculty: u.faculty,
        avatarRef: u.avatar_ref,
        contactPreference: u.contact_preference,
        preferredMode: u.preferred_mode,
      },
      createdAt: new Date(u.created_at).toISOString(),
    };
  }
}
