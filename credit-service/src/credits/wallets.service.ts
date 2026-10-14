import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiException, type Queryable } from '@foc/platform';
import { z } from 'zod';
import { AdminActivity } from './admin-activity.js';
import { CreditRepository } from './credit.repository.js';
import type { LedgerPage, WalletView } from './types.js';

const cursorSchema = z.object({
  occurredAt: z.iso.datetime(),
  transactionId: z.uuid(),
});

const encodeCursor = (value: z.infer<typeof cursorSchema>): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

function decodeCursor(value: string | undefined): z.infer<typeof cursorSchema> | undefined {
  if (!value) return undefined;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new ApiException(400, 'INVALID_CURSOR', 'The ledger cursor is invalid.');
  }
}

function parseLimit(value: string | undefined): number {
  const parsed = z.coerce.number().int().min(1).max(100).default(20).safeParse(value);
  if (!parsed.success) {
    throw new ApiException(400, 'INVALID_PAGE_SIZE', 'Limit must be a whole number from 1 to 100.');
  }
  return parsed.data;
}

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    @Inject(CreditRepository) private readonly credits: CreditRepository,
    @Inject(AdminActivity) private readonly activity: AdminActivity,
  ) {}

  async wallet(userId: string, queryable?: Queryable): Promise<WalletView> {
    const wallet = await this.credits.findWallet(userId, queryable);
    if (!wallet) throw new ApiException(404, 'WALLET_NOT_FOUND', 'Wallet not found.');
    return wallet;
  }

  async ledger(
    userId: string,
    limitValue?: string,
    cursorValue?: string,
    queryable?: Queryable,
  ): Promise<LedgerPage> {
    await this.wallet(userId, queryable);
    const limit = parseLimit(limitValue);
    const { rows, hasMore } = await this.credits.listLedger(
      userId,
      limit,
      decodeCursor(cursorValue),
      queryable,
    );
    const last = rows.at(-1);
    return {
      items: rows,
      nextCursor:
        hasMore && last
          ? encodeCursor({ occurredAt: last.occurredAt, transactionId: last.transactionId })
          : null,
    };
  }

  async adminWallet(
    adminUserId: string,
    targetUserId: string,
    correlationId: string,
  ): Promise<WalletView> {
    await this.credits.auditAdminRead(adminUserId, targetUserId, 'WALLET', correlationId);
    await this.watch(adminUserId);
    return this.wallet(targetUserId);
  }

  async adminLedger(
    adminUserId: string,
    targetUserId: string,
    correlationId: string,
    limit?: string,
    cursor?: string,
  ): Promise<LedgerPage> {
    await this.credits.auditAdminRead(adminUserId, targetUserId, 'LEDGER', correlationId);
    await this.watch(adminUserId);
    return this.ledger(targetUserId, limit, cursor);
  }

  /**
   * The bulk-read alert check (ADM-04). The read itself is already recorded, which is the control;
   * raising the alert is a side effect of it, so a failure here is logged and the read is answered.
   */
  private async watch(adminUserId: string): Promise<void> {
    try {
      await this.activity.afterWalletRead(adminUserId);
    } catch (err) {
      this.logger.error({ err, adminUserId, msg: 'wallet-read alert check failed' });
    }
  }
}
