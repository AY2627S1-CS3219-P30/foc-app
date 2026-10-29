import { Metrics, type OrderStatusChangedPayload } from '@foc/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LiveHub,
  type LiveOptions,
  type LiveSink,
  type Participants,
} from '../src/orders/live/live-hub.js';

/**
 * N1.4 (#329) — the routing rule and limits of live errand updates. A stream gets a nudge, never
 * the errand: `errand` to the errand's requester and courier, `board` to everyone when an errand
 * joins or leaves the open list.
 */
const ORDER = '00000000-0000-4000-8000-000000000129';
const OPTIONS: LiveOptions = {
  enabled: true,
  maxStreamMs: 300_000,
  perUser: 5,
  perInstance: 1_000,
  keepAliveMs: 20_000,
  boardIntervalMs: 1_000,
};

/** A stream's text, as the browser would receive it. */
class Received implements LiveSink {
  text = '';
  ended = false;
  write(chunk: string): void {
    this.text += chunk;
  }
  end(): void {
    this.ended = true;
  }
  /** The events received so far, by name; a keep-alive comment as `: keep-alive`. */
  get events(): string[] {
    return this.text
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => (frame.startsWith(':') ? frame : /^event: (\w+)/.exec(frame)![1]!));
  }
  /** The data of every `errand` event. */
  get errands(): unknown[] {
    return [...this.text.matchAll(/event: errand\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]!));
  }
}

const change = (
  previousStatus: OrderStatusChangedPayload['previousStatus'],
  newStatus: OrderStatusChangedPayload['newStatus'],
  orderVersion = 3,
): OrderStatusChangedPayload => ({
  orderId: ORDER,
  previousStatus,
  newStatus,
  occurredAt: new Date().toISOString(),
  orderVersion,
});

describe('live errand updates (N1.4)', () => {
  let hub: LiveHub;
  let metrics: Metrics;
  let participants: Participants | undefined;
  const reads: string[] = [];
  const participantsOf = async (orderId: string) => {
    reads.push(orderId);
    return participants;
  };
  const open = (userId: string) => {
    const sink = new Received();
    const opened = hub.open(userId, sink);
    return { sink, opened };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    metrics = new Metrics('order-service');
    hub = new LiveHub(OPTIONS, metrics);
    participants = { requesterId: 'requester', courierId: 'courier' };
    reads.length = 0;
  });
  afterEach(() => {
    hub.onModuleDestroy();
    vi.useRealTimers();
  });

  it('sends ready as soon as a stream opens, so the page reads everything once', () => {
    const { sink } = open('requester');
    expect(sink.events).toEqual(['ready']);
  });

  it("nudges an errand's requester and courier, with its version, and no one else", async () => {
    const requester = open('requester').sink;
    const courier = open('courier').sink;
    const stranger = open('stranger').sink;

    await hub.changed(change('ACCEPTED', 'PICKED_UP', 4), participantsOf);

    expect(requester.errands).toEqual([{ orderId: ORDER, version: 4 }]);
    expect(courier.errands).toEqual([{ orderId: ORDER, version: 4 }]);
    expect(stranger.events).toEqual(['ready']);
  });

  it('nudges only the requester while no courier has accepted', async () => {
    participants = { requesterId: 'requester', courierId: null };
    const requester = open('requester').sink;
    const courier = open('courier').sink;

    await hub.changed(change('PENDING_CREDIT', 'REJECTED'), participantsOf);

    expect(requester.errands).toHaveLength(1);
    expect(courier.errands).toEqual([]);
  });

  it('nudges every stream of a participant: one per open tab', async () => {
    const first = open('requester').sink;
    const second = open('requester').sink;

    await hub.changed(change('PICKED_UP', 'DELIVERED'), participantsOf);

    expect(first.errands).toHaveLength(1);
    expect(second.errands).toHaveLength(1);
  });

  it('tells every stream when an errand joins or leaves the board, and only then', async () => {
    const stranger = open('stranger').sink;

    await hub.changed(change('PENDING_CREDIT', 'OPEN'), participantsOf); // joins
    vi.advanceTimersByTime(1_000);
    await hub.changed(change('OPEN', 'ACCEPTED'), participantsOf); // leaves
    vi.advanceTimersByTime(1_000);
    await hub.changed(change('PICKED_UP', 'DELIVERED'), participantsOf); // neither

    expect(stranger.events).toEqual(['ready', 'board', 'board']);
  });

  it('sends the board at most once a second, and the last change of a burst still arrives', async () => {
    const stranger = open('stranger').sink;

    await hub.changed(change('PENDING_CREDIT', 'OPEN'), participantsOf);
    await hub.changed(change('PENDING_CREDIT', 'OPEN'), participantsOf);
    await hub.changed(change('OPEN', 'ACCEPTED'), participantsOf);
    expect(stranger.events).toEqual(['ready', 'board']);

    vi.advanceTimersByTime(1_000);
    expect(stranger.events).toEqual(['ready', 'board', 'board']);
    vi.advanceTimersByTime(5_000);
    expect(stranger.events).toEqual(['ready', 'board', 'board']);
  });

  it('refuses a sixth stream for one user, and any stream once the instance is full', () => {
    for (let i = 0; i < 5; i++) expect(open('requester').opened).not.toHaveProperty('refused');
    expect(open('requester').opened).toEqual({ refused: 'TOO_MANY_STREAMS' });

    hub = new LiveHub({ ...OPTIONS, perInstance: 2 }, new Metrics('order-service'));
    open('a');
    open('b');
    const full = open('c');
    expect(full.opened).toEqual({ refused: 'LIVE_UNAVAILABLE' });
    expect(full.sink.text).toBe('');
  });

  it('frees the place of a stream the client closed', () => {
    const streams = Array.from({ length: 5 }, () => open('requester').opened);
    expect(open('requester').opened).toEqual({ refused: 'TOO_MANY_STREAMS' });

    (streams[0] as { close(): void }).close();
    expect(open('requester').opened).not.toHaveProperty('refused');
  });

  it('refuses every stream when switched off (LIVE_UPDATES_ENABLED=false)', () => {
    hub = new LiveHub({ ...OPTIONS, enabled: false }, new Metrics('order-service'));
    expect(open('requester').opened).toEqual({ refused: 'LIVE_UNAVAILABLE' });
  });

  it('ends a stream after its lifetime, so the reconnect authenticates again', () => {
    const { sink } = open('requester');
    vi.advanceTimersByTime(299_999);
    expect(sink.ended).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sink.ended).toBe(true);
    // ... and its place is free again.
    for (let i = 0; i < 5; i++) expect(open('requester').opened).not.toHaveProperty('refused');
  });

  it('keeps an idle stream alive every 20 s, inside the edge read timeout', () => {
    const { sink } = open('requester');
    vi.advanceTimersByTime(40_000);
    expect(sink.events).toEqual(['ready', ': keep-alive', ': keep-alive']);
  });

  it('drops the errand nudge, without throwing, when the errand cannot be read', async () => {
    const requester = open('requester').sink;
    const failing = async () => {
      throw new Error('connection terminated');
    };

    await expect(hub.changed(change('OPEN', 'ACCEPTED'), failing)).resolves.toBeUndefined();

    expect(requester.events).toEqual(['ready', 'board']);
  });

  it('reads nothing when no stream is open', async () => {
    await hub.changed(change('ACCEPTED', 'PICKED_UP'), participantsOf);
    expect(reads).toEqual([]);
  });

  it('nudges without a version for a change written before versions were carried', async () => {
    const requester = open('requester').sink;
    const { orderVersion: _dropped, ...unversioned } = change('ACCEPTED', 'PICKED_UP');

    await hub.changed(unversioned, participantsOf);

    expect(requester.errands).toEqual([{ orderId: ORDER }]);
  });

  it('counts open streams, nudges and refusals for the dashboard', async () => {
    open('requester');
    open('courier');
    hub.open('requester', new Received());
    for (let i = 0; i < 3; i++) hub.open('requester', new Received());
    expect(hub.open('requester', new Received())).toEqual({ refused: 'TOO_MANY_STREAMS' });
    await hub.changed(change('OPEN', 'ACCEPTED'), participantsOf);

    const text = await metrics.render();
    expect(text).toMatch(/foc_live_streams\{[^}]*\} 6/);
    expect(text).toMatch(/foc_live_nudges_total\{kind="errand"[^}]*\} 6/);
    expect(text).toMatch(/foc_live_nudges_total\{kind="board"[^}]*\} 6/);
    expect(text).toMatch(/foc_live_refused_total\{reason="TOO_MANY_STREAMS"[^}]*\} 1/);
  });

  it('refuses a stream once the service is stopping, so none opens after the rest were ended', () => {
    hub.onModuleDestroy();
    expect(open('requester').opened).toEqual({ refused: 'LIVE_UNAVAILABLE' });
  });

  it('ends every stream when the service stops, so shutdown does not wait on them', () => {
    const first = open('requester').sink;
    const second = open('courier').sink;

    hub.onModuleDestroy();

    expect(first.ended && second.ended).toBe(true);
  });
});
