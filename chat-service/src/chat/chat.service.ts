// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-30 to 2026-11-05
// Scope: Generated the initial implementation for "channels and messages for an errand" (NTH-02,
//   #162, NTH-03); later bug fixes, new features and refactoring.
// Author review: Anselm Long, Jonus Ho and Zhang Yuan reviewed the implementation for correctness,
//   ran it against the test suite, and checked that it fits our service boundaries without fatal
//   errors before committing.

import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import { ChatRepository, type SendResult } from './chat.repository.js';
import { pastRetention, RETENTION_OPTIONS, type RetentionOptions } from './retention.js';
import { SocketHub } from './socket/socket-hub.js';
import { Upstreams, type OrderForChat } from './upstreams.js';
import type { Page, Send } from './validation.js';

const channelClosed = () =>
  new ApiException(409, 'CHANNEL_CLOSED', 'This errand has ended or has no courier.');
const notFound = () => new ApiException(404, 'NOT_FOUND', 'This errand has no chat.');
const notParticipant = () =>
  new ApiException(403, 'NOT_PARTICIPANT', "You are not this errand's requester or courier.");

interface Access {
  order: OrderForChat;
  role: 'REQUESTER' | 'COURIER' | 'ADMIN';
  latestSeq: number;
  /** Participants may send while the errand has a courier and has not reached a final status. */
  open: boolean;
}

/** Who asks, and the correlation ID an administrator's read is recorded under. */
export interface Caller {
  user: AuthContext;
  correlationId: string;
}

/**
 * One errand's channel (ADR 0012). Every call asks the Order Service who the errand's requester
 * and current courier are, and decides from that alone. Nothing here can change an errand: chat
 * only ever reads it.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(ChatRepository) private readonly chat: ChatRepository,
    @Inject(Upstreams) private readonly upstreams: Upstreams,
    @Inject(RETENTION_OPTIONS) private readonly retention: RetentionOptions,
    @Inject(SocketHub) private readonly sockets: SocketHub,
  ) {}

  async channel(orderId: string, { user, correlationId }: Caller) {
    const { order, role, latestSeq, open } = await this.access(orderId, user);
    const name = (userId: string) =>
      userId === user.userId ? user.displayName : this.upstreams.displayName(userId);
    const [requester, courier, lastReadSeq] = await Promise.all([
      name(order.requesterId),
      order.courierId ? name(order.courierId) : null,
      // An administrator only reads, so has no read position.
      role === 'ADMIN' ? 0 : this.chat.lastRead(orderId, user.userId),
    ]);
    if (role === 'ADMIN') {
      await this.chat.recordAdminRead(user.userId, orderId, 'CHANNEL', correlationId);
    }
    return {
      orderId,
      open,
      myRole: role,
      requester: { userId: order.requesterId, displayName: requester },
      courier: order.courierId ? { userId: order.courierId, displayName: courier! } : null,
      lastReadSeq,
      latestSeq,
    };
  }

  async messages(orderId: string, { user, correlationId }: Caller, page: Page) {
    const { role } = await this.access(orderId, user);
    const messages = await this.chat.page(orderId, page);
    if (role === 'ADMIN') {
      await this.chat.recordAdminRead(user.userId, orderId, 'MESSAGES', correlationId);
    }
    return messages;
  }

  /**
   * A repeated `clientId` answers the stored message, even once the channel has closed or the
   * sender has reached the limit. Over the limit, the result carries `retryAfter` instead. A new
   * message nudges both participants' sockets, the sender's other tabs included (#346).
   */
  async send(orderId: string, caller: AuthContext, { clientId, body }: Send): Promise<SendResult> {
    const { open, order } = await this.participantAccess(orderId, caller);
    const stored = await this.chat.findSent(orderId, caller.userId, clientId);
    if (!stored && !open) throw channelClosed();
    const sent = stored
      ? { message: stored, created: false }
      : await this.chat.send(orderId, caller.userId, clientId, body);
    if ('closed' in sent) throw channelClosed();
    if ('busy' in sent) {
      throw new ApiException(503, 'UNAVAILABLE', 'Chat is busy right now. Try again shortly.');
    }
    if ('message' in sent && !sent.created && sent.message.body !== body) {
      throw new ApiException(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This clientId already sent a different message.',
      );
    }
    if ('message' in sent && sent.created) {
      this.sockets.notify([order.requesterId, order.courierId], {
        orderId,
        latestSeq: sent.message.seq,
      });
    }
    return sent;
  }

  async markRead(orderId: string, caller: AuthContext, seq: number) {
    const { latestSeq } = await this.participantAccess(orderId, caller);
    if (seq > latestSeq) {
      throw new ApiException(422, 'VALIDATION_FAILED', 'One or more fields are invalid.', [
        { field: 'seq', code: 'too_big', message: `The channel's latest seq is ${latestSeq}.` },
      ]);
    }
    return { lastReadSeq: await this.chat.markRead(orderId, caller.userId, seq) };
  }

  /** Sending and marking read: an administrator who is not a participant is refused. */
  private async participantAccess(orderId: string, caller: AuthContext): Promise<Access> {
    const access = await this.access(orderId, caller);
    if (access.role === 'ADMIN') throw notParticipant();
    return access;
  }

  /**
   * The requester and the current courier, so a former courier loses access at once, and an
   * administrator to read; a participant who is also an administrator counts as the participant.
   * Past retention every route answers 404, to everyone. A participant's request opens a channel
   * while the errand has a courier and has not ended; an administrator's never does, and a
   * channel never opened answers 404.
   */
  private async access(orderId: string, caller: AuthContext): Promise<Access> {
    const order = await this.upstreams.order(orderId);
    if (!order || pastRetention(order, this.retention.retentionDays)) throw notFound();
    const role =
      caller.userId === order.requesterId
        ? 'REQUESTER'
        : caller.userId === order.courierId
          ? 'COURIER'
          : caller.isAdmin
            ? 'ADMIN'
            : undefined;
    const existing = await this.chat.latestSeq(orderId);
    if (!role) {
      // An errand with no courier and no channel may not be in the feed (pending credit,
      // rejected), so a stranger learns no more about it than about an unknown ID.
      if (existing === undefined && order.courierId === null) throw notFound();
      throw notParticipant();
    }
    const open = order.courierId !== null && order.endedAt === null;
    const latestSeq =
      existing ?? (open && role !== 'ADMIN' ? await this.chat.open(orderId) : undefined);
    if (latestSeq === undefined) throw notFound();
    return { order, role, latestSeq, open };
  }
}
