import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import { ChatRepository } from './chat.repository.js';
import { Upstreams, type OrderForChat } from './upstreams.js';
import type { Page, Send } from './validation.js';

const notFound = () => new ApiException(404, 'NOT_FOUND', 'This errand has no chat.');

interface Access {
  order: OrderForChat;
  role: 'REQUESTER' | 'COURIER';
  latestSeq: number;
  /** Participants may send while the errand has a courier and has not reached a final status. */
  open: boolean;
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
  ) {}

  async channel(orderId: string, caller: AuthContext) {
    const { order, role, latestSeq, open } = await this.access(orderId, caller);
    const name = (userId: string) =>
      userId === caller.userId ? caller.displayName : this.upstreams.displayName(userId);
    const [requester, courier, lastReadSeq] = await Promise.all([
      name(order.requesterId),
      order.courierId ? name(order.courierId) : null,
      this.chat.lastRead(orderId, caller.userId),
    ]);
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

  async messages(orderId: string, caller: AuthContext, page: Page) {
    await this.access(orderId, caller);
    return this.chat.page(orderId, page);
  }

  /** A repeated `clientId` answers the stored message, even once the channel has closed. */
  async send(orderId: string, caller: AuthContext, { clientId, body }: Send) {
    const { open } = await this.access(orderId, caller);
    const stored = await this.chat.findSent(orderId, caller.userId, clientId);
    if (!stored && !open) {
      throw new ApiException(409, 'CHANNEL_CLOSED', 'This errand has ended or has no courier.');
    }
    const sent = stored
      ? { message: stored, created: false }
      : await this.chat.send(orderId, caller.userId, clientId, body);
    if (!sent.created && sent.message.body !== body) {
      throw new ApiException(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This clientId already sent a different message.',
      );
    }
    return sent;
  }

  async markRead(orderId: string, caller: AuthContext, seq: number) {
    const { latestSeq } = await this.access(orderId, caller);
    if (seq > latestSeq) {
      throw new ApiException(422, 'VALIDATION_FAILED', 'One or more fields are invalid.', [
        { field: 'seq', code: 'too_big', message: `The channel's latest seq is ${latestSeq}.` },
      ]);
    }
    return { lastReadSeq: await this.chat.markRead(orderId, caller.userId, seq) };
  }

  /**
   * Only the requester and the current courier, so a former courier loses access at once; the
   * other refusals come with #163. A channel opens on the first such request while the errand
   * has a courier, and one never opened answers 404.
   */
  private async access(orderId: string, caller: AuthContext): Promise<Access> {
    const order = await this.upstreams.order(orderId);
    if (!order) throw notFound();
    const role =
      caller.userId === order.requesterId
        ? 'REQUESTER'
        : caller.userId === order.courierId
          ? 'COURIER'
          : undefined;
    if (!role) {
      throw new ApiException(
        403,
        'NOT_PARTICIPANT',
        "You are not this errand's requester or courier.",
      );
    }
    const latestSeq =
      (await this.chat.latestSeq(orderId)) ??
      (order.courierId ? await this.chat.open(orderId) : undefined);
    if (latestSeq === undefined) throw notFound();
    return { order, role, latestSeq, open: order.courierId !== null && order.endedAt === null };
  }
}
