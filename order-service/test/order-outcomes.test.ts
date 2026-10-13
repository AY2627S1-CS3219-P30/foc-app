import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS } from '@foc/platform';
import {
  asBystander,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import {
  COURIER,
  REQUESTER,
  SEEDED_ORDER,
  SEEDED_REWARD,
  advance,
  backdate,
  footprint,
  outboxOf,
  sweep,
} from './support/lifecycle.js';

const HOUR = 60 * 60_000;

const post = (t: TestApp, path: string, auth: string, expectedVersion: number) =>
  http(t)
    .post(`/orders/${SEEDED_ORDER}/${path}`)
    .set('Authorization', auth)
    .send({ expectedVersion });

const completionRequests = (t: TestApp) => outboxOf(t, EVENTS.ORDER_COMPLETION_REQUESTED);
const statusOf = async (t: TestApp) => (await t.orders.findById(SEEDED_ORDER))!.status;

const lastHistory = async (t: TestApp) => {
  const { body } = await http(t)
    .get(`/orders/${SEEDED_ORDER}/history`)
    .set('Authorization', asRequester)
    .expect(200);
  return (body.entries as Array<{ action: string; actorType: string; newStatus: string }>).map(
    ({ action, actorType, newStatus }) => ({ action, actorType, newStatus }),
  );
};

describe('requester outcome actions and auto-confirmation (ORD-10)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('saves each deadline when its period starts and shows both to the participants', async () => {
    t = await createTestApp();
    await advance(t, 'DELIVERED');
    const { body: history } = await http(t)
      .get(`/orders/${SEEDED_ORDER}/history`)
      .set('Authorization', asRequester)
      .expect(200);
    const at = (action: string) =>
      Date.parse(history.entries.find((e: { action: string }) => e.action === action).occurredAt);

    for (const auth of [asRequester, asStranger]) {
      const { body } = await http(t)
        .get(`/orders/${SEEDED_ORDER}?view=private`)
        .set('Authorization', auth)
        .expect(200);
      expect(Date.parse(body.nonDeliveryReportAt) - at('RECORD_PICKUP')).toBe(2 * HOUR);
      expect(Date.parse(body.autoConfirmAt) - at('RECORD_DELIVERY')).toBe(24 * HOUR);
    }
    const { body: summary } = await http(t)
      .get(`/orders/${SEEDED_ORDER}`)
      .set('Authorization', asBystander)
      .expect(200);
    expect(summary).not.toHaveProperty('nonDeliveryReportAt');
    expect(summary).not.toHaveProperty('autoConfirmAt');
  });

  it('refuses a non-delivery report before the delivery period has passed', async () => {
    t = await createTestApp();
    await advance(t, 'PICKED_UP');
    const before = await footprint(t);

    const refused = await post(t, 'report-non-delivery', asRequester, 4).expect(409);
    expect(refused.body.error).toMatchObject({
      code: 'INVALID_ORDER_STATE',
      details: { status: 'PICKED_UP', version: 4 },
    });
    expect(await footprint(t)).toEqual(before);
  });

  it('refers the errand to an administrator once the delivery period has passed', async () => {
    t = await createTestApp();
    await advance(t, 'PICKED_UP');
    await backdate(t, 'non_delivery_report_at', 1);

    const reported = await post(t, 'report-non-delivery', asRequester, 4).expect(200);
    expect(reported.body).toMatchObject({ status: 'DISPUTED', version: 5 });
    expect((await lastHistory(t)).slice(-1)).toEqual([
      { action: 'REPORT_NON_DELIVERY', actorType: 'REQUESTER', newStatus: 'DISPUTED' },
    ]);
  });

  it('refers a delivered errand the requester reports as not received', async () => {
    t = await createTestApp();
    await advance(t, 'DELIVERED');

    const reported = await post(t, 'report-non-receipt', asRequester, 5).expect(200);
    expect(reported.body).toMatchObject({ status: 'DISPUTED', version: 6 });
    expect((await lastHistory(t)).slice(-1)).toEqual([
      { action: 'REPORT_NON_RECEIPT', actorType: 'REQUESTER', newStatus: 'DISPUTED' },
    ]);
  });

  it('refuses a non-receipt report once the auto-confirmation period has passed', async () => {
    t = await createTestApp();
    await advance(t, 'DELIVERED');
    // Due, but no sweep has run yet.
    await backdate(t, 'auto_confirm_at', 1);
    const before = await footprint(t);

    const refused = await post(t, 'report-non-receipt', asRequester, 5).expect(409);
    expect(refused.body.error).toMatchObject({
      code: 'INVALID_ORDER_STATE',
      details: { status: 'DELIVERED', version: 5 },
    });
    expect(await footprint(t)).toEqual(before);
  });

  it('auto-confirms a delivered errand once its period has passed, requesting the transfer once', async () => {
    t = await createTestApp();
    await advance(t, 'DELIVERED');
    expect((await sweep(t)).autoConfirmed).toBe(0);
    expect(await statusOf(t)).toBe('DELIVERED');

    await backdate(t, 'auto_confirm_at', 1);
    expect((await sweep(t)).autoConfirmed).toBe(1);
    expect((await sweep(t)).autoConfirmed).toBe(0);

    expect(await statusOf(t)).toBe('COMPLETION_PENDING_CREDIT');
    expect(await completionRequests(t)).toEqual([
      { orderId: SEEDED_ORDER, requesterId: REQUESTER, courierId: COURIER, amount: SEEDED_REWARD },
    ]);
    expect((await lastHistory(t)).slice(-1)).toEqual([
      { action: 'AUTO_CONFIRM', actorType: 'SYSTEM', newStatus: 'COMPLETION_PENDING_CREDIT' },
    ]);
  });

  describe('a requester action and the auto-confirmation timer give one outcome', () => {
    it('confirm, then the timer: the timer finds nothing to do', async () => {
      t = await createTestApp();
      await advance(t, 'DELIVERED');
      await post(t, 'confirm-receipt', asRequester, 5).expect(200);
      await backdate(t, 'auto_confirm_at', 1);

      expect((await sweep(t)).autoConfirmed).toBe(0);
      expect(await statusOf(t)).toBe('COMPLETION_PENDING_CREDIT');
      expect(await completionRequests(t)).toHaveLength(1);
    });

    it('the timer, then confirm: the confirmation is refused', async () => {
      t = await createTestApp();
      await advance(t, 'DELIVERED');
      await backdate(t, 'auto_confirm_at', 1);
      expect((await sweep(t)).autoConfirmed).toBe(1);

      const refused = await post(t, 'confirm-receipt', asRequester, 5).expect(409);
      expect(refused.body.error.details).toEqual({
        status: 'COMPLETION_PENDING_CREDIT',
        version: 6,
      });
      expect(await completionRequests(t)).toHaveLength(1);
    });

    it('report, then the timer: the errand stays with an administrator and nothing is paid', async () => {
      t = await createTestApp();
      await advance(t, 'DELIVERED');
      await post(t, 'report-non-receipt', asRequester, 5).expect(200);
      await backdate(t, 'auto_confirm_at', 1);

      expect((await sweep(t)).autoConfirmed).toBe(0);
      expect(await statusOf(t)).toBe('DISPUTED');
      expect(await completionRequests(t)).toEqual([]);
    });
  });

  it.each([
    ['PICKED_UP', 'report-non-delivery', 4],
    ['DELIVERED', 'report-non-receipt', 5],
  ] as const)('a dispute raised from %s ignores every timer', async (from, path, version) => {
    t = await createTestApp();
    await advance(t, from);
    await backdate(t, 'non_delivery_report_at', 1);
    await post(t, path, asRequester, version).expect(200);
    for (const column of [
      'acceptance_deadline_at',
      'accepted_at',
      'non_delivery_report_at',
      'auto_confirm_at',
    ] as const) {
      await backdate(t, column, 48 * HOUR);
    }

    expect(await sweep(t)).toMatchObject({ expired: 0, pickupTimedOut: 0, autoConfirmed: 0 });
    expect(await statusOf(t)).toBe('DISPUTED');
    expect(await completionRequests(t)).toEqual([]);
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toEqual([]);
  });
});
