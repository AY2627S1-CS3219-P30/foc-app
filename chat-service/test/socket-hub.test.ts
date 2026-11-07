import { authFailure, type AuthContext, type Authenticator } from '@foc/auth-client';
import { Metrics } from '@foc/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocketHub, type Peer, type SocketOptions } from '../src/chat/socket/socket-hub.js';

/**
 * #346 — the chat socket's rules, without Nest or a network: sign in with the first frame, get
 * told only that a channel moved on, and be closed whenever the right to listen may have ended.
 */
const OPTIONS: SocketOptions = {
  authTimeoutMs: 5_000,
  recheckMs: 60_000,
  pingMs: 25_000,
  perUser: 5,
  perInstance: 1_000,
  pendingPerInstance: 100,
};
const ORDER = '00000000-0000-4000-8000-000000000346';

/** A WebSocket as the client sees it: what it was sent, and how it was closed. */
class FakePeer implements Peer {
  readonly frames: unknown[] = [];
  closed?: { code: number; reason: string };
  terminated = false;
  pings = 0;
  /** A browser answers every ping by itself; set to stop answering. */
  answer?: () => void;
  send(frame: string): void {
    this.frames.push(JSON.parse(frame));
  }
  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }
  ping(): void {
    this.pings += 1;
    this.answer?.();
  }
  terminate(): void {
    this.terminated = true;
  }
}

/** A JWT-shaped token for `person`, expiring at `exp` (epoch seconds) when given. */
const token = (person: string, exp?: number) =>
  [
    'header',
    Buffer.from(JSON.stringify({ sub: person, ...(exp === undefined ? {} : { exp }) })).toString(
      'base64url',
    ),
    'signature',
  ].join('.');

describe('chat sockets (#346)', () => {
  let hub: SocketHub;
  let metrics: Metrics;
  /** Sessions the User Service no longer accepts, by user. */
  const revoked = new Set<string>();
  /** Set while the User Service cannot answer. */
  let outage = false;
  /** While set, every sign-in waits on it, as on a slow User Service. */
  let held: Promise<void> | undefined;

  const authenticator: Authenticator = {
    async authenticate(header) {
      if (held) await held;
      if (outage) throw authFailure('IDENTITY_UNAVAILABLE');
      const raw = /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '';
      const sub = (JSON.parse(Buffer.from(raw.split('.')[1] ?? '', 'base64url').toString() || '{}')
        .sub ?? 'nobody') as string;
      if (sub === 'nobody' || revoked.has(sub)) throw authFailure('TOKEN_REVOKED');
      return {
        userId: sub,
        sessionId: `session-${sub}`,
        displayName: sub,
        roles: ['STUDENT'],
        status: 'ACTIVE',
        isAdmin: false,
      } satisfies AuthContext;
    },
    requireAdmin() {},
    invalidateUser() {},
  };

  const connect = () => {
    const peer = new FakePeer();
    const socket = hub.connect(peer);
    peer.answer = () => hub.pong(socket);
    return { peer, socket };
  };
  const signIn = async (person: string, exp?: number) => {
    const { peer, socket } = connect();
    await hub.received(socket, { type: 'auth', token: token(person, exp) });
    return { peer, socket };
  };
  const nudges = (peer: FakePeer) =>
    peer.frames.filter((f) => (f as { type: string }).type === 'messages');
  /** A gauge's current value. */
  const gauge = (name: string) =>
    metrics.registry
      .getSingleMetricAsString(name)
      .then((text) => Number(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\d+)$`, 'm').exec(text)?.[1]));
  /** A hub with these options in place of the default, measured by `metrics`. */
  const useHub = (options: Partial<SocketOptions>) => {
    hub.onModuleDestroy();
    metrics = new Metrics('chat-service');
    hub = new SocketHub({ ...OPTIONS, ...options }, authenticator, metrics);
  };
  const closedCount = (reason: string) =>
    metrics.registry
      .getSingleMetricAsString('foc_chat_socket_closes_total')
      .then((text) => Number(new RegExp(`reason="${reason}"[^}]*} (\\d+)`).exec(text)?.[1] ?? 0));

  beforeEach(() => {
    vi.useFakeTimers();
    metrics = new Metrics('chat-service');
    hub = new SocketHub(OPTIONS, authenticator, metrics);
    revoked.clear();
    outage = false;
    held = undefined;
  });
  afterEach(() => {
    hub.onModuleDestroy();
    vi.useRealTimers();
  });

  describe('signing in', () => {
    it('opens a socket whose first frame signs in within 5 s, and says ready', async () => {
      const { peer, socket } = connect();
      vi.advanceTimersByTime(4_999);
      await hub.received(socket, { type: 'auth', token: token('requester') });
      expect(peer.frames).toEqual([{ type: 'ready' }]);
      vi.advanceTimersByTime(10_000);
      expect(peer.closed).toBeUndefined();
    });

    it('closes a socket that sends nothing for 5 s with 4408', () => {
      const { peer } = connect();
      vi.advanceTimersByTime(4_999);
      expect(peer.closed).toBeUndefined();
      vi.advanceTimersByTime(1);
      expect(peer.closed?.code).toBe(4408);
    });

    it('closes a bad token with 4401, and never says ready', async () => {
      const { peer, socket } = connect();
      await hub.received(socket, { type: 'auth', token: 'not-a-token' });
      expect(peer.closed?.code).toBe(4401);
      expect(peer.frames).toEqual([]);
    });

    it('closes with 4503, not 4401, when the User Service cannot answer', async () => {
      outage = true;
      const { peer } = await signIn('requester');
      expect(peer.closed).toEqual({
        code: 4503,
        reason: 'Could not verify your identity. Try again shortly.',
      });
      expect(peer.frames).toEqual([]);
      expect(await closedCount('identity-unavailable')).toBe(1);
      expect(await closedCount('unauthenticated')).toBe(0);
    });

    it('closes with 4400 on a frame that is not an auth frame', async () => {
      const { peer, socket } = connect();
      await hub.received(socket, { type: 'malformed' });
      expect(peer.closed?.code).toBe(4400);
    });

    it('closes with 4400 on a second auth frame, once open or while the first is checked', async () => {
      const open = await signIn('requester');
      await hub.received(open.socket, { type: 'auth', token: token('requester') });
      expect(open.peer.closed?.code).toBe(4400);

      const racing = connect();
      const first = hub.received(racing.socket, { type: 'auth', token: token('courier') });
      await hub.received(racing.socket, { type: 'auth', token: token('courier') });
      await first;
      expect(racing.peer.closed?.code).toBe(4400);
      expect(racing.peer.frames).toEqual([]);
    });

    it('closes an open socket with 4400 on any later frame', async () => {
      const { peer, socket } = await signIn('requester');
      await hub.received(socket, { type: 'malformed' });
      expect(peer.closed?.code).toBe(4400);
    });
  });

  describe('nudges', () => {
    it("reaches every open socket of both participants, the sender's other tabs too, and no one else", async () => {
      const requesterTabs = [await signIn('requester'), await signIn('requester')];
      const courier = await signIn('courier');
      const stranger = await signIn('stranger');
      const unsigned = connect();

      hub.notify(['requester', 'courier'], { orderId: ORDER, latestSeq: 4 });

      for (const { peer } of [...requesterTabs, courier]) {
        expect(nudges(peer)).toEqual([{ type: 'messages', orderId: ORDER, latestSeq: 4 }]);
      }
      expect(nudges(stranger.peer)).toEqual([]);
      expect(unsigned.peer.frames).toEqual([]);
    });

    it('sends a user one nudge per socket however often they are named, and none for no courier', async () => {
      const requester = await signIn('requester');
      hub.notify(['requester', 'requester', null], { orderId: ORDER, latestSeq: 1 });
      expect(nudges(requester.peer)).toHaveLength(1);
    });

    it('keeps going past a socket that cannot be written to', async () => {
      const broken = await signIn('requester');
      broken.peer.send = () => {
        throw new Error('not open');
      };
      const courier = await signIn('courier');
      expect(() =>
        hub.notify(['requester', 'courier'], { orderId: ORDER, latestSeq: 2 }),
      ).not.toThrow();
      expect(nudges(courier.peer)).toHaveLength(1);
    });
  });

  describe('limits', () => {
    it('closes a sixth open socket of one user with 4429', async () => {
      const tabs = await Promise.all(Array.from({ length: 5 }, () => signIn('requester')));
      const sixth = await signIn('requester');
      expect(tabs.every(({ peer }) => peer.closed === undefined)).toBe(true);
      expect(sixth.peer.closed?.code).toBe(4429);
      expect((await signIn('courier')).peer.closed).toBeUndefined();
    });

    it('closes a connection past the instance cap with 4429', () => {
      hub.onModuleDestroy();
      hub = new SocketHub(
        { ...OPTIONS, perInstance: 2 },
        authenticator,
        new Metrics('chat-service'),
      );
      connect();
      connect();
      expect(connect().peer.closed?.code).toBe(4429);
    });

    it('makes room by closing the oldest socket still waiting for its auth frame, with 4429 (#370)', async () => {
      useHub({ pendingPerInstance: 2 });
      const [oldest, second, newest] = [connect(), connect(), connect()];
      expect(oldest.peer.closed?.code).toBe(4429);
      expect(second.peer.closed).toBeUndefined();
      expect(newest.peer.closed).toBeUndefined();
      // Counted apart from a user's sixth tab, so a flood of idle sockets shows as one.
      expect(await closedCount('too-many-pending')).toBe(1);
      expect(await closedCount('too-many')).toBe(0);
      await hub.received(newest.socket, { type: 'auth', token: token('requester') });
      expect(newest.peer.frames).toEqual([{ type: 'ready' }]);
    });

    it('lets a real user sign in however many clients never do (#370)', async () => {
      useHub({ perInstance: 10, pendingPerInstance: 2 });
      for (const person of ['a', 'b', 'c', 'd']) {
        expect((await signIn(person)).peer.closed).toBeUndefined();
      }
      // Clients that never sign in only push each other out, and never hold more than two places
      // of the six the instance has left.
      const idle = Array.from({ length: 5 }, () => connect());
      expect(idle.map(({ peer }) => peer.closed?.code)).toEqual([
        4429,
        4429,
        4429,
        undefined,
        undefined,
      ]);
      expect(await gauge('foc_chat_sockets')).toBe(6);
      expect(await gauge('foc_chat_sockets_waiting')).toBe(2);
      const requester = await signIn('requester');
      expect(requester.peer.frames).toEqual([{ type: 'ready' }]);
      expect(await gauge('foc_chat_sockets_waiting')).toBe(1);
    });

    it('refuses a new socket, and closes none, while every waiting socket is signing in (#370)', async () => {
      useHub({ pendingPerInstance: 2 });
      let release!: () => void;
      held = new Promise<void>((resolve) => (release = resolve));
      const signingIn = [connect(), connect()];
      const answers = signingIn.map(({ socket }, i) =>
        hub.received(socket, { type: 'auth', token: token(`user-${i}`) }),
      );
      const late = connect();
      expect(late.peer.closed?.code).toBe(4429);
      expect(signingIn.map(({ peer }) => peer.closed)).toEqual([undefined, undefined]);
      release();
      await Promise.all(answers);
      expect(signingIn.map(({ peer }) => peer.frames)).toEqual([
        [{ type: 'ready' }],
        [{ type: 'ready' }],
      ]);
      // Signed in, they wait no more, so the next socket gets a place.
      expect(connect().peer.closed).toBeUndefined();
    });
  });

  describe('closing when the right to listen may have ended', () => {
    it('closes every socket of a user whose identity changed with 4401, and only theirs', async () => {
      const requesterTabs = [await signIn('requester'), await signIn('requester')];
      const courier = await signIn('courier');

      hub.identityChanged('requester');

      expect(requesterTabs.map(({ peer }) => peer.closed?.code)).toEqual([4401, 4401]);
      expect(courier.peer.closed).toBeUndefined();
      hub.notify(['requester', 'courier'], { orderId: ORDER, latestSeq: 1 });
      expect(requesterTabs.flatMap(({ peer }) => nudges(peer))).toEqual([]);
      expect(nudges(courier.peer)).toHaveLength(1);
    });

    it('closes a socket whose session is revoked at the next check, 60 s on', async () => {
      const requester = await signIn('requester');
      const courier = await signIn('courier');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requester.peer.closed).toBeUndefined();

      revoked.add('requester');
      await vi.advanceTimersByTimeAsync(59_999);
      expect(requester.peer.closed).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(requester.peer.closed?.code).toBe(4401);
      expect(courier.peer.closed).toBeUndefined();
    });

    it('closes with 4503, not 4401, when the User Service cannot answer a check', async () => {
      const { peer } = await signIn('requester');
      outage = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(peer.closed).toEqual({
        code: 4503,
        reason: 'Could not verify your identity. Try again shortly.',
      });
      expect(await closedCount('identity-unavailable')).toBe(1);
      expect(await closedCount('unauthenticated')).toBe(0);
    });

    it("closes at the token's expiry", async () => {
      const exp = Math.floor(Date.now() / 1000) + 30;
      const { peer } = await signIn('requester', exp);
      vi.advanceTimersByTime(exp * 1000 - Date.now() - 1);
      expect(peer.closed).toBeUndefined();
      vi.advanceTimersByTime(1);
      expect(peer.closed?.code).toBe(4401);
    });

    it('closes at once a token that has already expired', async () => {
      const { peer } = await signIn('requester', Math.floor(Date.now() / 1000) - 1);
      expect(peer.closed?.code).toBe(4401);
      expect(peer.frames).toEqual([]);
    });

    it('relies on the recheck when the token names no expiry', async () => {
      const { peer } = await signIn('requester');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(peer.closed).toBeUndefined();
    });
  });

  describe('keep-alive', () => {
    it('pings every 25 s, and drops a socket that missed the last ping', async () => {
      const answering = await signIn('requester');
      const silent = await signIn('courier');
      silent.peer.answer = undefined;
      vi.advanceTimersByTime(25_000);
      expect([answering.peer.pings, silent.peer.pings]).toEqual([1, 1]);
      expect(silent.peer.terminated).toBe(false);

      vi.advanceTimersByTime(25_000);
      expect(answering.peer.pings).toBe(2);
      expect(silent.peer.terminated).toBe(true);
      expect(answering.peer.terminated).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('closes every socket with 1001, and refuses new ones', async () => {
      const open = await signIn('requester');
      const unsigned = connect();
      hub.onModuleDestroy();
      expect([open.peer.closed?.code, unsigned.peer.closed?.code]).toEqual([1001, 1001]);
      expect(connect().peer.closed?.code).toBe(1001);
    });
  });

  it('closes a socket once, whatever ends it and however often', async () => {
    const { peer, socket } = await signIn('requester');
    const close = vi.spyOn(peer, 'close');
    hub.identityChanged('requester');
    hub.disconnected(socket);
    hub.identityChanged('requester');
    hub.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(4401, expect.any(String));
    expect(await closedCount('identity-changed')).toBe(1);
    expect(await closedCount('client-closed')).toBe(0);
  });

  it('forgets a socket the client closed, and sends it nothing more', async () => {
    const { peer, socket } = await signIn('requester');
    hub.disconnected(socket);
    hub.notify(['requester'], { orderId: ORDER, latestSeq: 1 });
    expect(nudges(peer)).toEqual([]);
    expect(peer.closed).toBeUndefined();
  });
});
