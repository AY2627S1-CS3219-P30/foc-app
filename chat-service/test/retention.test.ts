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

/**
 * #372: a run reads a page of channels at a time, so its memory doesn't grow with their number, and
 * asks the Order Service about only a few at once, so a long run neither takes hours nor floods it.
 */
describe('the retention cleanup works through channels in batches', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `order-${i + 1}`);
  const ended: OrderForChat = {
    status: 'COMPLETED',
    version: 5,
    requesterId: 'user-requester',
    courierId: 'user-courier',
    endedAt: new Date(Date.now() - 91 * DAY_MS).toISOString(),
  };

  /** A repository holding `all`, in order, that records each page it is asked for. */
  const repository = (all: string[]) => {
    const pages: { limit: number; after?: string }[] = [];
    const deleted: string[] = [];
    const chat = {
      channelsOpenedBefore: async (_cutoff: Date, limit: number, after?: string) => {
        pages.push({ limit, after });
        return all.slice(
          after ? all.indexOf(after) + 1 : 0,
          (after ? all.indexOf(after) + 1 : 0) + limit,
        );
      },
      deleteChannel: async (orderId: string) => void deleted.push(orderId),
    };
    return { chat: chat as unknown as ChatRepository, pages, deleted };
  };
  const cleanup = (
    chat: ChatRepository,
    order: (orderId: string) => Promise<OrderForChat | undefined>,
    sizes = { batchSize: 3, concurrency: 2 },
  ) =>
    new RetentionCleanup(chat, { order } as unknown as Upstreams, {
      retentionDays: 90,
      intervalMs: DAY_MS,
      retryMs: RETRY_MS,
      ...sizes,
    });

  beforeEach(() => Logger.overrideLogger(false));

  it('reads one page at a time until a page comes back short', async () => {
    const { chat, pages, deleted } = repository(ids(7));
    const result = await cleanup(chat, async () => ended).sweep();
    expect(pages).toEqual([
      { limit: 3, after: undefined },
      { limit: 3, after: 'order-3' },
      { limit: 3, after: 'order-6' },
    ]);
    expect([...deleted].sort()).toEqual([...ids(7)].sort());
    expect(result).toEqual({ deleted: 7, kept: 0, skipped: 0, unknown: 0 });
  });

  it('reads one more, empty page when the last page is exactly full', async () => {
    const { chat, pages } = repository(ids(6));
    expect((await cleanup(chat, async () => ended).sweep()).deleted).toBe(6);
    expect(pages.map((page) => page.after)).toEqual([undefined, 'order-3', 'order-6']);
  });

  it('asks the Order Service about several at once, never more than the limit', async () => {
    const { chat } = repository(ids(9));
    let asking = 0;
    let most = 0;
    await cleanup(chat, async () => {
      asking += 1;
      most = Math.max(most, asking);
      await new Promise((resolve) => setImmediate(resolve));
      asking -= 1;
      return ended;
    }).sweep();
    expect(most).toBe(2);
  });

  it('counts every outcome across pages', async () => {
    const { chat, deleted } = repository(ids(5));
    const answers: Record<string, () => OrderForChat | undefined> = {
      'order-1': () => ended,
      'order-2': () => ({ ...ended, endedAt: null }),
      'order-3': () => undefined,
      'order-4': () => {
        throw new Error('Order Service unavailable');
      },
      'order-5': () => ended,
    };
    const result = await cleanup(chat, async (orderId) => answers[orderId]!()).sweep();
    expect(result).toEqual({ deleted: 2, kept: 1, skipped: 1, unknown: 1 });
    expect([...deleted].sort()).toEqual(['order-1', 'order-5']);
  });

  it('fails the run on a failed delete, after work under way ends and with no further page', async () => {
    const { chat, pages } = repository(ids(7));
    chat.deleteChannel = async (orderId: string) => {
      if (orderId === 'order-1') throw new Error('database unavailable');
      finished.push(orderId);
    };
    const finished: string[] = [];
    await expect(cleanup(chat, async () => ended).sweep()).rejects.toThrow('database unavailable');
    expect(pages).toHaveLength(1);
    // The page finishes: `sweep` settles only when every channel on it has been tried.
    expect(finished).toEqual(['order-2', 'order-3']);
  });

  it('finishes the page after a failed delete when working one at a time too', async () => {
    const { chat, pages } = repository(ids(7));
    const finished: string[] = [];
    chat.deleteChannel = async (orderId: string) => {
      if (orderId === 'order-1') throw new Error('database unavailable');
      finished.push(orderId);
    };
    const sweep = cleanup(chat, async () => ended, { batchSize: 3, concurrency: 1 }).sweep();
    await expect(sweep).rejects.toThrow('database unavailable');
    expect(pages).toHaveLength(1);
    expect(finished).toEqual(['order-2', 'order-3']);
  });

  it('logs what a failed run had already done', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { chat } = repository(ids(3));
    chat.deleteChannel = async (orderId: string) => {
      if (orderId === 'order-2') throw new Error('database unavailable');
    };
    const run = cleanup(chat, async () => ended);
    run.start();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    await run.onApplicationShutdown();
    expect(error.mock.calls[0]![0]).toMatchObject({ deleted: 2, skipped: 0 });
    error.mockRestore();
  });

  it.each([{ batchSize: 0 }, { batchSize: -1 }, { batchSize: 1.5 }, { concurrency: 0 }])(
    'refuses to start with %o, which could never finish a run',
    (sizes) => {
      const { chat } = repository([]);
      expect(() =>
        cleanup(chat, async () => ended, { batchSize: 3, concurrency: 2, ...sizes }),
      ).toThrow(/at least 1/);
    },
  );

  it('handles a page shorter than the concurrency', async () => {
    const { chat, pages, deleted } = repository(ids(2));
    const result = await cleanup(chat, async () => ended, { batchSize: 5, concurrency: 5 }).sweep();
    expect(result.deleted).toBe(2);
    expect(deleted).toHaveLength(2);
    expect(pages).toHaveLength(1);
  });

  it('skips every channel, and deletes nothing, while Order stays down across pages', async () => {
    const { chat, pages, deleted } = repository(ids(7));
    const result = await cleanup(chat, async () => {
      throw new Error('Order Service unavailable');
    }).sweep();
    expect(result).toEqual({ deleted: 0, kept: 0, skipped: 7, unknown: 0 });
    expect(deleted).toEqual([]);
    expect(pages).toHaveLength(3);
  });
});
