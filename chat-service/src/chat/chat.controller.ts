// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-30 to 2026-11-03
// Scope: Generated the initial implementation for "channels and messages for an errand" (NTH-02,
//   #162, NTH-03); later new features.
// Author review: Anselm Long and Zhang Yuan verified correctness, tested the change, and checked
//   for fatal errors and conflicts with our architecture before committing.

import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Authenticated, CurrentUser, type AuthContext, type AuthedRequest } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import type { Response } from 'express';
import { SEND_LIMIT } from './chat.repository.js';
import { ChatService, type Caller } from './chat.service.js';
import { parseMarkRead, parseOrderId, parsePage, parseSend } from './validation.js';

type CorrelatedRequest = AuthedRequest & { correlationId?: string; id?: string };

const caller = (user: AuthContext, request: CorrelatedRequest): Caller => ({
  user,
  correlationId: request.correlationId ?? request.id ?? 'unknown',
});

/** contracts/chat-service.openapi.yaml */
@Controller('channels')
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Get(':orderId')
  @Authenticated()
  channel(
    @Param('orderId') orderId: string,
    @CurrentUser() user: AuthContext,
    @Req() request: CorrelatedRequest,
  ) {
    return this.chat.channel(parseOrderId(orderId), caller(user, request));
  }

  @Get(':orderId/messages')
  @Authenticated()
  messages(
    @Param('orderId') orderId: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthContext,
    @Req() request: CorrelatedRequest,
  ) {
    return this.chat.messages(parseOrderId(orderId), caller(user, request), parsePage(query));
  }

  @Post(':orderId/messages')
  @Authenticated()
  async send(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const sent = await this.chat.send(parseOrderId(orderId), user, parseSend(body));
    if ('retryAfter' in sent) {
      response.setHeader('Retry-After', String(sent.retryAfter));
      throw new ApiException(
        429,
        'RATE_LIMITED',
        `You have sent ${SEND_LIMIT.messages} messages in the last minute. Try again shortly.`,
      );
    }
    response.status(sent.created ? 201 : 200);
    return sent.message;
  }

  @Put(':orderId/read')
  @Authenticated()
  read(@Param('orderId') orderId: string, @Body() body: unknown, @CurrentUser() user: AuthContext) {
    return this.chat.markRead(parseOrderId(orderId), user, parseMarkRead(body));
  }
}
