// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-30 to 2026-11-04
// Scope: Generated the initial implementation for "channels and messages for an errand" (NTH-02,
//   #162); later bug fixes.
// Author review: Anselm Long and Zhang Yuan checked the code for correctness against the ticket,
//   confirmed the tests pass, and made sure it caused no fatal errors or architectural conflicts
//   before committing.

import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '@foc/platform';
import { z } from 'zod';
import { env } from '../config.js';

export const UPSTREAM_FETCH = Symbol('UPSTREAM_FETCH');

const orderSchema = z.object({
  status: z.string(),
  version: z.number().int(),
  requesterId: z.string().min(1),
  courierId: z.string().min(1).nullable(),
  // Not a bare string: one Date.parse cannot read would never count as past retention.
  endedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type OrderForChat = z.infer<typeof orderSchema>;

const userSchema = z.object({ exists: z.boolean(), displayName: z.string().optional() });

/** Shown for a participant the User Service no longer has, rather than failing the channel. */
export const FORMER_STUDENT = 'A former student';

const unavailable = () =>
  new ApiException(
    503,
    'UNAVAILABLE',
    'Chat cannot check this errand right now. Try again shortly.',
  );

/**
 * The Order and User Services, asked with this service's own key (ADR 0012). Anything but a clear
 * answer fails closed with 503 UNAVAILABLE, before anything is read or stored.
 */
@Injectable()
export class Upstreams {
  constructor(@Inject(UPSTREAM_FETCH) private readonly fetchFn: typeof fetch) {}

  /** The errand's participants and status; undefined when no errand has this ID. */
  async order(orderId: string): Promise<OrderForChat | undefined> {
    const response = await this.ask(
      new URL(`/internal/orders/${orderId}/chat`, env.ORDER_SERVICE_URL),
    );
    return response.status === 404 ? undefined : this.parse(response, orderSchema);
  }

  async displayName(userId: string): Promise<string> {
    const url = new URL(`/internal/users/${encodeURIComponent(userId)}`, env.USER_SERVICE_URL);
    const user = await this.parse(await this.ask(url), userSchema);
    if (!user.exists) return FORMER_STUDENT;
    if (!user.displayName) throw unavailable();
    return user.displayName;
  }

  private async ask(url: URL): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        headers: { 'X-Service-Key': env.INTERNAL_SERVICE_KEY },
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      throw unavailable();
    }
  }

  private async parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    if (!response.ok) throw unavailable();
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }
}
