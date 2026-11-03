import { Body, Controller, Get, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Authenticated, CurrentUser, type AuthContext } from '@foc/auth-client';
import type { Response } from 'express';
import { ChatService } from './chat.service.js';
import { parseMarkRead, parseOrderId, parsePage, parseSend } from './validation.js';

/** contracts/chat-service.openapi.yaml */
@Controller('channels')
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Get(':orderId')
  @Authenticated()
  channel(@Param('orderId') orderId: string, @CurrentUser() caller: AuthContext) {
    return this.chat.channel(parseOrderId(orderId), caller);
  }

  @Get(':orderId/messages')
  @Authenticated()
  messages(
    @Param('orderId') orderId: string,
    @Query() query: unknown,
    @CurrentUser() caller: AuthContext,
  ) {
    return this.chat.messages(parseOrderId(orderId), caller, parsePage(query));
  }

  @Post(':orderId/messages')
  @Authenticated()
  async send(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const sent = await this.chat.send(parseOrderId(orderId), caller, parseSend(body));
    response.status(sent.created ? 201 : 200);
    return sent.message;
  }

  @Put(':orderId/read')
  @Authenticated()
  read(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @CurrentUser() caller: AuthContext,
  ) {
    return this.chat.markRead(parseOrderId(orderId), caller, parseMarkRead(body));
  }
}
