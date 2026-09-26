import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard, type AuthedRequest } from '../auth/access-token.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import {
  auditQuerySchema,
  parseOrThrow,
  reasonSchema,
  roleChangeSchema,
  userIdSchema,
  userListQuerySchema,
} from '../users/validation.js';
import { AdminService } from './admin.service.js';

const correlationOf = (req: Request): string =>
  (req as Request & { correlationId?: string }).correlationId ?? 'unknown';

/** Every route here needs a live session *and* the ADMIN role — deny by default. */
@Controller('admin')
@UseGuards(AccessTokenGuard, AdminGuard)
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('users')
  list(@Query() query: unknown) {
    return this.admin.listUsers(parseOrThrow(userListQuerySchema, query));
  }

  @Get('users/:userId')
  get(@Param('userId') userId: string) {
    return this.admin.getUser(parseOrThrow(userIdSchema, userId));
  }

  @Post('users/:userId/suspend')
  @HttpCode(200)
  suspend(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const { reason } = parseOrThrow(reasonSchema, body);
    return this.admin.suspend(
      req.auth.userId,
      parseOrThrow(userIdSchema, userId),
      reason,
      correlationOf(req),
    );
  }

  @Post('users/:userId/reactivate')
  @HttpCode(200)
  reactivate(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const { reason } = parseOrThrow(reasonSchema, body);
    return this.admin.reactivate(
      req.auth.userId,
      parseOrThrow(userIdSchema, userId),
      reason,
      correlationOf(req),
    );
  }

  @Put('users/:userId/role')
  setRole(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const { role, reason } = parseOrThrow(roleChangeSchema, body);
    return this.admin.setRole(
      req.auth.userId,
      parseOrThrow(userIdSchema, userId),
      role,
      reason,
      correlationOf(req),
    );
  }

  /** Read-only. There is no route that creates, edits or deletes an audit record. */
  @Get('audit-records')
  audit(@Query() query: unknown) {
    return this.admin.listAudit(parseOrThrow(auditQuerySchema, query));
  }
}
