import { afterEach, describe, expect, it } from 'vitest';
import {
  asAdmin,
  asOtherAdmin,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import {
  SEEDED_ORDER,
  advance,
  backdate,
  createPending,
  dispute,
  footprint,
  reservationReply,
  sweep,
} from './support/lifecycle.js';

const send = (t: TestApp, path: string, auth: string, key: string, body: object) =>
  http(t).post(path).set('Authorization', auth).set('Idempotency-Key', key).send(body);

/** With nothing changed since, a replay's answer is the original; only the server's clock moves on. */
const answer = ({ status, body }: { status: number; body: Record<string, unknown> }) => {
  const { serverTime: _serverTime, ...rest } = body;
  return { status, body: rest };
};

const versionOf = async (t: TestApp, orderId = SEEDED_ORDER) =>
  (await t.orders.findById(orderId))!.version;

interface Command {
  name: string;
  /** Brings the seeded order to where the command applies, and says who may send it. */
  setup: (t: TestApp) => Promise<string>;
  path: string;
  body?: Record<string, string>;
}

const COMMANDS: Command[] = [
  { name: 'accept', setup: async () => asStranger, path: 'accept' },
  {
    name: 'pickup',
    setup: async (t) => (await advance(t, 'ACCEPTED'), asStranger),
    path: 'pickup',
  },
  {
    name: 'deliver',
    setup: async (t) => (await advance(t, 'PICKED_UP'), asStranger),
    path: 'deliver',
  },
  {
    name: 'confirm-receipt',
    setup: async (t) => (await advance(t, 'DELIVERED'), asRequester),
    path: 'confirm-receipt',
  },
  { name: 'cancel', setup: async () => asRequester, path: 'cancel' },
  {
    name: 'withdraw',
    setup: async (t) => (await advance(t, 'ACCEPTED'), asStranger),
    path: 'withdraw',
  },
  {
    name: 'report-non-delivery',
    setup: async (t) => {
      await advance(t, 'PICKED_UP');
      await backdate(t, 'non_delivery_report_at', 1_000);
      return asRequester;
    },
    path: 'report-non-delivery',
  },
  {
    name: 'report-non-receipt',
    setup: async (t) => (await advance(t, 'DELIVERED'), asRequester),
    path: 'report-non-receipt',
  },
  {
    name: 'resolve',
    setup: async (t) => {
      await dispute(t, 'DELIVERED');
      await sweep(t);
      const referred = (await t.orders.findById(SEEDED_ORDER))!.referredAdminId;
      return referred === 'admin-1' ? asAdmin : asOtherAdmin;
    },
    path: 'resolve',
    body: { outcome: 'COURIER', reason: 'The courier showed a photo of the handover.' },
  },
];

const pathOf = (command: Command, orderId = SEEDED_ORDER) =>
  command.name === 'resolve'
    ? `/admin/orders/${orderId}/resolve`
    : `/orders/${orderId}/${command.path}`;

describe('order commands replay a retry sent with the same Idempotency-Key (OS-FR7.1.1)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it.each(COMMANDS)(
    'a repeated $name returns the first answer and changes nothing more',
    async (command) => {
      t = await createTestApp();
      const auth = await command.setup(t);
      const body = { ...command.body, expectedVersion: await versionOf(t) };

      const first = await send(t, pathOf(command), auth, 'key-1', body);
      expect(first.status).toBeLessThan(300);
      const after = await footprint(t);

      const repeat = await send(t, pathOf(command), auth, 'key-1', body);
      expect(answer(repeat)).toEqual(answer(first));
      expect(await footprint(t)).toEqual(after);
    },
  );

  it('a repeat after the errand moved on answers with the errand as it now is', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    const pickup = `/orders/${SEEDED_ORDER}/pickup`;
    await send(t, pickup, asStranger, 'key-1', { expectedVersion: 3 }).expect(200);
    await send(t, `/orders/${SEEDED_ORDER}/deliver`, asStranger, 'key-2', {
      expectedVersion: 4,
    }).expect(200);
    const after = await footprint(t);

    const repeat = await send(t, pickup, asStranger, 'key-1', { expectedVersion: 3 }).expect(200);
    expect(repeat.body).toMatchObject({ status: 'DELIVERED', version: 5 });
    expect(await footprint(t)).toEqual(after);
  });

  it('a courier who left the errand replays their accept without its private details', async () => {
    t = await createTestApp();
    const accept = `/orders/${SEEDED_ORDER}/accept`;
    const first = await send(t, accept, asStranger, 'key-1', { expectedVersion: 2 }).expect(201);
    expect(first.body.deliveryInstructions).toBeDefined();
    await send(t, `/orders/${SEEDED_ORDER}/withdraw`, asStranger, 'key-2', {
      expectedVersion: 3,
    }).expect(200);
    const after = await footprint(t);

    const repeat = await send(t, accept, asStranger, 'key-1', { expectedVersion: 2 }).expect(201);
    expect(repeat.body).toMatchObject({ status: 'OPEN', version: 4 });
    for (const field of ['deliveryInstructions', 'requesterId', 'courierId']) {
      expect(repeat.body, field).not.toHaveProperty(field);
    }
    expect(repeat.body.items.every((item: object) => !('note' in item))).toBe(true);
    expect(await footprint(t)).toEqual(after);
  });

  it.each([
    ['command', () => [`/orders/${SEEDED_ORDER}/withdraw`, 3] as const],
    ['order', (other: string) => [`/orders/${other}/accept`, 2] as const],
    ['version', () => [`/orders/${SEEDED_ORDER}/accept`, 3] as const],
  ])('the same key with a different %s is refused and changes nothing', async (_, request) => {
    t = await createTestApp();
    const other = await createPending(t);
    await reservationReply(t, other);
    await send(t, `/orders/${SEEDED_ORDER}/accept`, asStranger, 'key-1', {
      expectedVersion: 2,
    }).expect(201);
    const [path, expectedVersion] = request(other);
    const before = [await footprint(t), await footprint(t, other)];

    const reused = await send(t, path, asStranger, 'key-1', { expectedVersion }).expect(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect([await footprint(t), await footprint(t, other)]).toEqual(before);
  });

  it.each([
    ['outcome', { outcome: 'REQUESTER', reason: 'The courier showed a photo of the handover.' }],
    ['reason', { outcome: 'COURIER', reason: 'The requester agreed it arrived.' }],
  ])(
    'the same key with a decision of a different %s is refused and changes nothing',
    async (_, decision) => {
      t = await createTestApp();
      const resolve = COMMANDS.find((command) => command.name === 'resolve')!;
      const auth = await resolve.setup(t);
      const expectedVersion = await versionOf(t);
      await send(t, pathOf(resolve), auth, 'key-1', { ...resolve.body, expectedVersion }).expect(
        200,
      );
      const before = await footprint(t);

      const reused = await send(t, pathOf(resolve), auth, 'key-1', {
        ...decision,
        expectedVersion,
      }).expect(422);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await footprint(t)).toEqual(before);
    },
  );

  it('two users sending the same key do not affect each other', async () => {
    t = await createTestApp();
    await send(t, `/orders/${SEEDED_ORDER}/accept`, asStranger, 'shared', {
      expectedVersion: 2,
    }).expect(201);

    const cancelled = await send(t, `/orders/${SEEDED_ORDER}/cancel`, asRequester, 'shared', {
      expectedVersion: 3,
    }).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'RELEASE_PENDING_CREDIT', version: 4 });
  });

  it('a report refused as too early can be retried with the same key once the period passes', async () => {
    t = await createTestApp();
    await advance(t, 'PICKED_UP');
    const report = () =>
      send(t!, `/orders/${SEEDED_ORDER}/report-non-delivery`, asRequester, 'key-1', {
        expectedVersion: 4,
      });
    const early = await report().expect(409);
    expect(early.body.error.code).toBe('DELIVERY_PERIOD_NOT_PASSED');

    await backdate(t, 'non_delivery_report_at', 1_000);
    const reported = await report().expect(200);
    expect(reported.body).toMatchObject({ status: 'DISPUTED', version: 5 });
  });

  it.each(COMMANDS)(
    'a malformed key on $name is refused before anything changes',
    async (command) => {
      t = await createTestApp();
      const auth = await command.setup(t);
      const before = await footprint(t);

      for (const key of ['', 'k'.repeat(201)]) {
        const refused = await send(t, pathOf(command), auth, key, {
          ...command.body,
          expectedVersion: before.order!.version,
        }).expect(400);
        expect(refused.body.error.code, `key of ${key.length}`).toBe('INVALID_IDEMPOTENCY_KEY');
      }
      expect(await footprint(t)).toEqual(before);
    },
  );
});
