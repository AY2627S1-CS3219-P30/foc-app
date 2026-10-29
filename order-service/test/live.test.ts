import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AUTHENTICATOR } from '@foc/auth-client';
import {
  createEnvelope,
  EVENTS,
  METRICS,
  type Metrics,
  type OrderStatusChangedPayload,
} from '@foc/platform';
import { afterEach, describe, expect, it } from 'vitest';
import { liveStatusHandler } from '../src/orders/live/live-events.js';
import { LIVE_OPTIONS, LiveHub, type LiveOptions } from '../src/orders/live/live-hub.js';
import {
  asRequester,
  asStranger,
  createTestApp,
  fakeAuthenticator,
  http,
  type TestApp,
} from './helpers/app.js';

/**
 * N1.4 (#329) — `GET /live` over real HTTP: who may open a stream, what it answers, and that an
 * accept reaches the requester's open stream through the status change the accept wrote.
 */
const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';

interface OpenStream {
  response: Response;
  /** Resolves with the next complete frame (`event: …\ndata: …`), or rejects after `ms`. */
  next(ms?: number): Promise<string>;
  close(): void;
}

async function connect(t: TestApp, authorization?: string): Promise<OpenStream> {
  const { port } = t.app.getHttpServer().address() as AddressInfo;
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/live`, {
    headers: authorization ? { authorization } : {},
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    response,
    async next(ms = 2_000) {
      const deadline = Date.now() + ms;
      while (!buffered.includes('\n\n')) {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no frame in time')), deadline - Date.now()),
        );
        const { value, done } = await Promise.race([reader.read(), timeout]);
        if (done) throw new Error('stream ended');
        buffered += decoder.decode(value, { stream: true });
      }
      const at = buffered.indexOf('\n\n');
      const frame = buffered.slice(0, at);
      buffered = buffered.slice(at + 2);
      return frame;
    },
    close: () => controller.abort(),
  };
}

/**
 * A GET with a body, as some clients send: Node has read the request, and emitted its `close`,
 * before the stream opens. Resolves once the stream has sent something, with a way to drop it.
 * `abortAfterMs` drops it before any answer, as a browser leaving mid-request does.
 */
function rawStream(t: TestApp, abortAfterMs?: number): Promise<() => void> {
  const { port } = t.app.getHttpServer().address() as AddressInfo;
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/live',
        method: 'GET',
        headers: {
          authorization: asRequester,
          'content-type': 'application/json',
          'content-length': '2',
        },
      },
      (res) => {
        res.once('data', () => resolve(() => req.destroy()));
        res.once('end', () => resolve(() => undefined));
      },
    );
    req.on('error', () => undefined);
    req.end('{}');
    if (abortAfterMs !== undefined) {
      setTimeout(() => {
        req.destroy();
        resolve(() => undefined);
      }, abortAfterMs);
    }
  });
}

/** The requester's next stream answers 200 within two seconds, once nothing holds their places. */
async function placeFreed(t: TestApp, streams: OpenStream[]): Promise<number> {
  const deadline = Date.now() + 2_000;
  let status = 429;
  while (status === 429 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const retry = await connect(t, asRequester);
    status = retry.response.status;
    streams.push(retry);
  }
  return status;
}

const live = (overrides: Partial<LiveOptions>) =>
  createTestApp(undefined, (builder) =>
    builder.overrideProvider(LIVE_OPTIONS).useValue({
      enabled: true,
      maxStreamMs: 300_000,
      perUser: 5,
      perInstance: 1_000,
      keepAliveMs: 20_000,
      boardIntervalMs: 1_000,
      ...overrides,
    }),
  );

describe('GET /live (N1.4)', () => {
  let t: TestApp | undefined;
  const streams: OpenStream[] = [];
  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await t?.close();
    t = undefined;
  });
  const open = async (authorization?: string) => {
    const stream = await connect(t!, authorization);
    streams.push(stream);
    return stream;
  };

  it('refuses a caller with no token, with the shared error envelope', async () => {
    t = await createTestApp();
    const response = await http(t).get('/live').expect(401);
    expect(response.body.error.code).toBe('TOKEN_MISSING');
  });

  it('answers an event stream the edge must not buffer, starting with ready', async () => {
    t = await createTestApp();
    const stream = await open(asRequester);

    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(stream.response.headers.get('cache-control')).toBe('no-store');
    expect(stream.response.headers.get('x-accel-buffering')).toBe('no');
    expect(await stream.next()).toBe('event: ready\ndata: {}');
  });

  it("refuses a user's sixth stream (429 TOO_MANY_STREAMS), asking them to wait a minute", async () => {
    t = await createTestApp();
    for (let i = 0; i < 5; i++) await (await open(asRequester)).next();

    const refused = await http(t).get('/live').set('Authorization', asRequester).expect(429);
    expect(refused.body.error.code).toBe('TOO_MANY_STREAMS');
    expect(refused.headers['retry-after']).toBe('60');
    // Someone else still gets one.
    expect(await (await open(asStranger)).next()).toBe('event: ready\ndata: {}');
  });

  it('refuses every stream when switched off (503 LIVE_UNAVAILABLE), so pages poll', async () => {
    t = await live({ enabled: false });
    const refused = await http(t).get('/live').set('Authorization', asRequester).expect(503);
    expect(refused.body.error.code).toBe('LIVE_UNAVAILABLE');
    expect(refused.headers['retry-after']).toBe('60');
  });

  it("frees a user's place when their browser closes a stream", async () => {
    t = await createTestApp();
    const first = await open(asRequester);
    await first.next();
    for (let i = 0; i < 4; i++) await (await open(asRequester)).next();
    await http(t).get('/live').set('Authorization', asRequester).expect(429);

    first.close();
    const deadline = Date.now() + 2_000;
    let status = 429;
    while (status === 429 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      const retry = await connect(t, asRequester);
      status = retry.response.status;
      streams.push(retry);
    }
    expect(status).toBe(200);
  });

  it('frees the places of streams that sent a body, once their browser goes', async () => {
    t = await createTestApp();
    const drops = await Promise.all(Array.from({ length: 5 }, () => rawStream(t!)));
    for (const drop of drops) drop();

    expect(await placeFreed(t, streams)).toBe(200);
  });

  it('opens no stream for a browser that left while it was being authenticated', async () => {
    const slowly = {
      ...fakeAuthenticator,
      async authenticate(header: string | undefined) {
        await new Promise((r) => setTimeout(r, 150));
        return fakeAuthenticator.authenticate(header);
      },
    };
    t = await createTestApp(undefined, (builder) =>
      builder.overrideProvider(AUTHENTICATOR).useValue(slowly),
    );
    await Promise.all(Array.from({ length: 5 }, () => rawStream(t!, 20)));
    await new Promise((r) => setTimeout(r, 300));

    expect(await placeFreed(t, streams)).toBe(200);
  });

  it('is not counted in the request latencies: a stream lasts minutes by design', async () => {
    t = await createTestApp();
    const stream = await open(asRequester);
    await stream.next();
    stream.close();
    await http(t).get('/orders').set('Authorization', asRequester).expect(200);

    const text = await t.app.get<Metrics>(METRICS).render();
    expect(text).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/orders"/);
    expect(text).not.toMatch(/http_request_duration_seconds_count\{[^}]*route="\/live"/);
  });

  it('stops without waiting on an open stream, which it ends', async () => {
    t = await createTestApp();
    const stream = await open(asRequester);
    await stream.next();

    const stopping = t.close();
    t = undefined;
    await expect(stream.next()).rejects.toThrow('stream ended');
    await stopping;
  });

  it("brings an accept to the requester's open stream, from the status change it wrote", async () => {
    t = await createTestApp();
    const requester = await open(asRequester);
    const stranger = await open(asStranger);
    await requester.next();
    await stranger.next();

    await http(t)
      .post(`/orders/${SEEDED_ORDER}/accept`)
      .set('Authorization', asStranger)
      .send({ expectedVersion: 2 })
      .expect(201);
    // The row the relay would publish; the queue delivers it to this handler.
    const { rows } = await t.db.query<{ payload: OrderStatusChangedPayload }>(
      `SELECT payload FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2
        ORDER BY seq DESC LIMIT 1`,
      [EVENTS.ORDER_STATUS_CHANGED, SEEDED_ORDER],
    );
    const handle = liveStatusHandler(t.app.get(LiveHub), t.orders);
    await handle(
      createEnvelope({
        eventType: EVENTS.ORDER_STATUS_CHANGED,
        schemaVersion: 1,
        aggregateId: SEEDED_ORDER,
        producer: 'order-service',
        correlationId: 'live-test',
        payload: rows[0]!.payload,
      }),
    );

    // It left the board, so everyone hears that; the requester also hears which errand.
    expect(await requester.next()).toBe('event: board\ndata: {}');
    expect(await requester.next()).toBe(
      `event: errand\ndata: ${JSON.stringify({ orderId: SEEDED_ORDER, version: 3 })}`,
    );
    expect(await stranger.next()).toBe('event: board\ndata: {}');
    // The stranger is now its courier, so hears it too.
    expect(await stranger.next()).toBe(
      `event: errand\ndata: ${JSON.stringify({ orderId: SEEDED_ORDER, version: 3 })}`,
    );
  });
});
