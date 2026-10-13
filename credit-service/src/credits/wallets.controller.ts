import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import {
  AdminOnly,
  Authenticated,
  CurrentUser,
  type AuthContext,
  type AuthedRequest,
} from '@foc/auth-client';
import { WalletsService } from './wallets.service.js';

type CorrelatedRequest = AuthedRequest & { correlationId?: string; id?: string };

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(WalletsService) private readonly wallets: WalletsService) {}

  @Get('me')
  @Authenticated()
  me(@CurrentUser() user: AuthContext) {
    return this.wallets.wallet(user.userId);
  }

  @Get('me/ledger')
  @Authenticated()
  myLedger(
    @CurrentUser() user: AuthContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.wallets.ledger(user.userId, limit, cursor);
  }
}

@Controller('admin/wallets')
export class AdminWalletsController {
  constructor(@Inject(WalletsService) private readonly wallets: WalletsService) {}

  @Get(':userId')
  @AdminOnly()
  wallet(
    @CurrentUser() admin: AuthContext,
    @Param('userId') userId: string,
    @Req() request: CorrelatedRequest,
  ) {
    return this.wallets.adminWallet(
      admin.userId,
      userId,
      request.correlationId ?? request.id ?? 'unknown',
    );
  }

  @Get(':userId/ledger')
  @AdminOnly()
  ledger(
    @CurrentUser() admin: AuthContext,
    @Param('userId') userId: string,
    @Req() request: CorrelatedRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.wallets.adminLedger(
      admin.userId,
      userId,
      request.correlationId ?? request.id ?? 'unknown',
      limit,
      cursor,
    );
  }
}
