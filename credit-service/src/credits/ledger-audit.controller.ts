import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { AdminOnly, CurrentUser, type AuthContext } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import { LedgerAuditService } from './ledger-audit.service.js';

@Controller('admin/ledger-audits')
export class LedgerAuditController {
  constructor(@Inject(LedgerAuditService) private readonly audit: LedgerAuditService) {}

  @Get('latest')
  @AdminOnly()
  async latest() {
    return { run: await this.audit.latest() };
  }

  @Post('run')
  @HttpCode(200)
  @AdminOnly()
  async run(@CurrentUser() caller: AuthContext) {
    const run = await this.audit.run('MANUAL', caller.userId);
    if (!run)
      throw new ApiException(
        409,
        'LEDGER_AUDIT_BUSY',
        'Another ledger audit is running. Try again shortly.',
      );
    return { run };
  }
}
