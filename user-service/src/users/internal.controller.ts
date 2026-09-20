import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { ServiceKeyGuard } from '../auth/service-key.guard.js';
import { UsersService } from './users.service.js';
import { parseOrThrow, userIdSchema } from './validation.js';

/** Service-to-service lookups. Guarded by `X-Service-Key`; a user token is not accepted. */
@Controller('internal/users')
@UseGuards(ServiceKeyGuard)
export class InternalController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get(':userId')
  lookup(@Param('userId') userId: string) {
    return this.users.lookup(parseOrThrow(userIdSchema, userId));
  }

  @Get(':userId/permissions')
  permissions(@Param('userId') userId: string) {
    return this.users.permissions(parseOrThrow(userIdSchema, userId));
  }
}
