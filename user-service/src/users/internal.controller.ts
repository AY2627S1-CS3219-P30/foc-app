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

  @Get('users/:userId')
  lookup(@Param('userId') userId: string) {
    return this.users.lookup(parseOrThrow(userIdSchema, userId));
  }

  @Get('users/:userId/permissions')
  permissions(@Param('userId') userId: string) {
    return this.users.permissions(parseOrThrow(userIdSchema, userId));
  }
}
