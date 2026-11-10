// AI Assistance Disclosure:
// Tool: Claude Code (Claude Sonnet 5, Claude Opus 5.5), dates: 2026-09-20 to 2026-10-12
// Scope: Generated the initial implementation for "registration, one-time activation and identity
//   lookup" (USR-01, USR-06); later new features.
// Author review: Anselm Long and Zhang Yuan validated correctness and the implementation, and
//   checked for fatal errors and architectural conflicts, before committing.

import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ServiceKeyGuard } from '../auth/service-key.guard.js';
import { UsersService } from './users.service.js';
import { introspectQuerySchema, parseOrThrow, userIdSchema } from './validation.js';

/** Service-to-service lookups. Guarded by `X-Service-Key`; a user token is not accepted. */
@Controller('internal')
@UseGuards(ServiceKeyGuard)
export class InternalController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  /** For the shared auth middleware: session liveness plus identity in one call. */
  @Get('introspect')
  introspect(@Query() query: unknown) {
    const { sid, sub } = parseOrThrow(introspectQuerySchema, query);
    return this.users.introspect(sid, sub);
  }

  @Get('admins')
  admins() {
    return this.users.listActiveAdmins();
  }

  @Get('users/:userId')
  lookup(@Param('userId') userId: string) {
    return this.users.lookup(parseOrThrow(userIdSchema, userId));
  }

  @Get('users/:userId/permissions')
  permissions(@Param('userId') userId: string) {
    return this.users.permissions(parseOrThrow(userIdSchema, userId));
  }
}
