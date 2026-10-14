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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard, type AuthedRequest } from '../auth/access-token.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import {
  alertsQuerySchema,
  auditQuerySchema,
  parseOrThrow,
  readsQuerySchema,
  reasonSchema,
  roleChangeSchema,
  roleRequestQuerySchema,
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

  /** Full account records: each one listed is recorded as read (ADR 0008). */
  @Get('users')
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    return this.admin.listUsers(
      req.auth.userId,
      parseOrThrow(userListQuerySchema, query),
      correlationOf(req),
    );
  }

  /** Name, email, roles and status, to find an account; no profile, so not recorded per account. */
  @Get('directory')
  directory(@Query() query: unknown) {
    return this.admin.listDirectory(parseOrThrow(userListQuerySchema, query));
  }

  /** Recorded as an admin read unless it is the caller's own account (ADR 0008). */
  @Get('users/:userId')
  get(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.admin.readUser(
      req.auth.userId,
      parseOrThrow(userIdSchema, userId),
      correlationOf(req),
    );
  }

  @Post('users/:userId/suspend')
  @HttpCode(200)
  suspend(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const { reason } = parseOrThrow(reasonSchema, body);
    return this.admin.suspend(
      req.auth.userId,
      req.auth.sessionId,
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
      req.auth.sessionId,
      parseOrThrow(userIdSchema, userId),
      reason,
      correlationOf(req),
    );
  }

  /**
   * Asks for a role change (ADR 0008). `202` with the pending request when another admin must
   * approve it; `200` with the account when it applied at once (no eligible approver) or changed
   * nothing (the role is already held).
   */
  @Put('users/:userId/role')
  async setRole(
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { role, reason } = parseOrThrow(roleChangeSchema, body);
    const result = await this.admin.requestRoleChange(
      req.auth.userId,
      req.auth.sessionId,
      parseOrThrow(userIdSchema, userId),
      role,
      reason,
      correlationOf(req),
    );
    if (result.applied) return result.user;
    res.status(202);
    return { request: result.request };
  }

  @Get('role-requests')
  roleRequests(@Query() query: unknown) {
    return this.admin.listRoleRequests(parseOrThrow(roleRequestQuerySchema, query));
  }

  /** The second admin's approval: the only way a requested role change applies. */
  @Post('role-requests/:requestId/approve')
  @HttpCode(200)
  approve(@Param('requestId') requestId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const { reason } = parseOrThrow(reasonSchema, body);
    return this.admin.approveRoleRequest(
      req.auth.userId,
      req.auth.sessionId,
      parseOrThrow(userIdSchema, requestId),
      reason,
      correlationOf(req),
    );
  }

  /** Refuses a request, or withdraws one's own. */
  @Post('role-requests/:requestId/reject')
  @HttpCode(200)
  reject(@Param('requestId') requestId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const { reason } = parseOrThrow(reasonSchema, body);
    return this.admin.rejectRoleRequest(
      req.auth.userId,
      req.auth.sessionId,
      parseOrThrow(userIdSchema, requestId),
      reason,
      correlationOf(req),
    );
  }

  /** Read-only. There is no route that creates, edits or deletes an audit record. */
  @Get('audit-records')
  audit(@Query() query: unknown) {
    return this.admin.listAudit(parseOrThrow(auditQuerySchema, query));
  }

  /** Which admin read which account, and when (ADR 0008). Read-only. */
  @Get('reads')
  reads(@Query() query: unknown) {
    return this.admin.listReads(parseOrThrow(readsQuerySchema, query));
  }

  /** Unusual admin activity (ADR 0008). Read-only. */
  @Get('alerts')
  alerts(@Query() query: unknown) {
    return this.admin.listAlerts(parseOrThrow(alertsQuerySchema, query));
  }
}
