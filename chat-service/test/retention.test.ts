import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRepository } from '../src/chat/chat.repository.js';
import { RetentionCleanup } from '../src/chat/retention.js';
import type { OrderForChat, Upstreams } from '../src/chat/upstreams.js';

const DAY_MS = 24 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;

/**
 * ADR 0012 §6: when the Order Service does not answer, as on a stack restart where chat is up
 * first, the cleanup tries once more shortly rather than a whole interval later.
 */
describe('the retention cleanup retries a run the Order Service did not answer', () => {
  let cleanup: RetentionCleanup;
  let deleted: string[];
  let lookups: number;
  let orderDown: boolean;

  beforeEach(() => {
    Logger.overrideLogger(false);
    vi.useFakeTimers();
    deleted = [];
    lookups = 0;
    orderDown = true;
    const chat = {
      channelsOpenedBefore: async () => ['order-expired'],
      deleteChannel: async (orderId: string) => void deleted.push(orderId),
    } as unknown as ChatRepository;
    const upstreams = {
      order: async (): Promise<OrderForChat> => {
        lookups += 1;
        if (orderDown) throw new Error('Order Service unavailable');
        return {
          status: 'COMPLETED',
          version: 5,
          requesterId: 'user-requester',
          courierId: 'user-courier',
          endedAt: new Date(Date.now() - 91 * DAY_MS).toISOString(),
        };
      },
    } as unknown as Upstreams;
    cleanup = new RetentionCleanup(chat, upstreams, {
      retentionDays: 90,
      intervalMs: DAY_MS,
      retryMs: RETRY_MS,
    });
  });

  afterEach(async () => {
    await cleanup.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('deletes on the retry once the Order Service answers', async () => {
    cleanup.start();
    await vi.advanceTimersByTimeAsync(0);
    expect([lookups, deleted]).toEqual([1, []]);

    orderDown = false;
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect([lookups, deleted]).toEqual([1, []]);
    await vi.advanceTimersByTimeAsync(1);
    expect([lookups, deleted]).toEqual([2, ['order-expired']]);
  });

  it('retries once, then waits for the next interval', async () => {
    cleanup.start();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(lookups).toBe(2);
    await vi.advanceTimersByTimeAsync(DAY_MS - RETRY_MS - 1);
    expect(lookups).toBe(2);

    // The next interval's run skips too, so it gets its own retry.
    await vi.advanceTimersByTimeAsync(1);
    expect(lookups).toBe(3);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect([lookups, deleted]).toEqual([4, []]);
  });

  it('does not retry a run that skipped nothing', async () => {
    orderDown = false;
    cleanup.start();
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect([lookups, deleted]).toEqual([1, ['order-expired']]);
  });

  it('schedules no retry once shut down', async () => {
    cleanup.start();
    await vi.advanceTimersByTimeAsync(0);
    await cleanup.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(DAY_MS * 2);
    expect(lookups).toBe(1);
  });
});
