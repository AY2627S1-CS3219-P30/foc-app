import { Logger } from '@nestjs/common';
import { METRICS, type Metrics } from '@foc/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { as, createTestApp, http, message, type Person, type TestApp } from './helpers/app.js';
import { SocketClient } from './helpers/socket-client.js';

/**
 * #346 over a real socket: the chat app with the ws adapter on a random port. A socket hears that
 * a channel moved on, never what was said, and only its participants hear it.
 */
let t: TestApp;
const clients: SocketClient[] = [];
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await t.close();
  vi.restoreAllMocks();
});

const connect = (path?: string) => {
  const client = new SocketClient(t, path);
  clients.push(client);
  return client;
};
const signIn = (who: Person) => connect().signIn(who);
const send = (orderId: string, body: object, who: Person = 'requester') =>
  http(t).post(`/channels/${orderId}/messages`).set('Authorization', as(who)).send(body);

describe('the chat socket (#346)', () => {
  it('nudges both participants within 1 s of a message, without its text', async () => {
    const orderId = t.upstreams.errand();
    const requester = await signIn('requester');
    const courier = await signIn('courier');
    expect(courier.frames).toEqual([{ type: 'ready' }]);

    await send(orderId, message('meet at the lobby')).expect(201);

    const [, nudge] = await courier.received(2, 1_000);
    expect(nudge).toEqual({ type: 'messages', orderId, latestSeq: 1 });
    expect(JSON.stringify(courier.frames)).not.toContain('lobby');
    // The sender's own socket too, which stands for their other tabs.
    expect((await requester.received(2))[1]).toEqual(nudge);
  });

  it('tells a stranger nothing', async () => {
    const orderId = t.upstreams.errand();
    const stranger = await signIn('stranger');
    const courier = await signIn('courier');

    await send(orderId, message('first')).expect(201);
    await send(orderId, message('second')).expect(201);

    await courier.received(3);
    expect(stranger.frames).toEqual([{ type: 'ready' }]);
  });

  it('sends no second nudge for a replayed send', async () => {
    const orderId = t.upstreams.errand();
    const courier = await signIn('courier');
    const first = message('only once');

    await send(orderId, first).expect(201);
    await send(orderId, first).expect(200);
    await send(orderId, message('the next one')).expect(201);

    await courier.received(3);
    expect(courier.frames.slice(1)).toEqual([
      { type: 'messages', orderId, latestSeq: 1 },
      { type: 'messages', orderId, latestSeq: 2 },
    ]);
  });

  it('does not take a token from the query string: the socket still has to sign in', async () => {
    const client = connect('/socket?token=requester');
    await client.opened();
    expect(await client.closed).toMatchObject({ code: 4408 });
    expect(client.frames).toEqual([]);
  });

  it('closes a socket whose token is refused with 4401, and one that sends anything else with 4400', async () => {
    const refused = connect();
    await refused.send({ type: 'auth', token: 'nobody' });
    expect(await refused.closed).toMatchObject({ code: 4401 });

    const garbled = connect();
    await garbled.send('not json');
    expect(await garbled.closed).toMatchObject({ code: 4400 });

    const extra = await signIn('requester');
    await extra.send({ type: 'auth', token: 'requester' });
    expect(await extra.closed).toMatchObject({ code: 4400 });
  });

  it('closes a socket that breaks the protocol with its code, counted, and logged at WARN with no stack (#369)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const error = vi.spyOn(Logger.prototype, 'error');
    // A masked frame with the reserved opcode 3, and a text frame past the 16 KiB ws accepts.
    const cases = [
      { send: (c: SocketClient) => c.raw(Buffer.from([0x83, 0x80, 0, 0, 0, 0])), code: 1002 },
      { send: (c: SocketClient) => c.send('x'.repeat(20 * 1024)), code: 1009 },
    ];
    for (const { send, code } of cases) {
      const client = connect();
      await send(client);
      expect(await client.closed).toMatchObject({ code });
    }
    const logged = warn.mock.calls.filter((call) => JSON.stringify(call).includes('chat socket'));
    // Every one is counted, but a burst is logged once a minute, so a client looping on bad frames
    // can't flood the log.
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toMatch(/\s+at /);
    expect(error).not.toHaveBeenCalled();
    const counted = await t.app
      .get<Metrics>(METRICS)
      .registry.getSingleMetricAsString('foc_chat_socket_protocol_errors_total');
    const total = [...counted.matchAll(/^foc_chat_socket_protocol_errors_total\{[^}]*\} (\d+)$/gm)]
      .map((m) => Number(m[1]))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(2);
  });
});
