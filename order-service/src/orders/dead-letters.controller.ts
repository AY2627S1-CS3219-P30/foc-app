import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { AdminOnly, CurrentUser, type AuthContext } from '@foc/auth-client';
import {
  DEAD_LETTERS,
  parseDeadLetterId,
  parseDeadLetterQuery,
  parseRedriveReason,
  type DeadLetters,
} from '@foc/platform';
import type { Request } from 'express';

/**
 * PLT-05 (EI-FR3.1.2) — the Order Service's dead letters: Credit's replies its consumers could not
 * apply. Administrator-only. A redrive delivers the stored message, unchanged, to the queue it
 * failed on, and records who did it and why.
 */
@Controller('admin/dead-letters')
export class DeadLettersController {
  constructor(@Inject(DEAD_LETTERS) private readonly letters: DeadLetters) {}

  @Get()
  @AdminOnly()
  list(@Query() query: unknown) {
    return this.letters.list(parseDeadLetterQuery(query));
  }

  @Get(':id')
  @AdminOnly()
  get(@Param('id') id: string) {
    return this.letters.get(parseDeadLetterId(id));
  }

  @Post(':id/redrive')
  @HttpCode(200)
  @AdminOnly()
  redrive(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Req() request: Request & { correlationId?: string },
  ) {
    return this.letters.redrive(parseDeadLetterId(id), {
      actorId: caller.userId,
      reason: parseRedriveReason(body),
      correlationId: request.correlationId ?? 'unknown',
    });
  }
}
