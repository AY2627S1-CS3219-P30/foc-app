import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateOrderInput } from '../src/orders/validation.js';
import { asRequester, createTestApp, http, type TestApp } from './helpers/app.js';

const supplierId = '00000000-0000-4000-8000-000000000125';
const order: CreateOrderInput = {
  supplierId,
  items: [{ name: 'Chicken rice', quantity: 1 }],
  deliveryZone: 'COM2 Lobby',
  deliveryInstructions: 'Meet beside the security desk',
  reward: 3,
};
const supplier = {
  supplierId,
  name: 'The Deck',
  type: 'FOOD',
  building: 'COM2',
  floor: '1',
  locationDescription: 'Level 1 canteen',
  active: true,
};

describe('observability (PLT-04)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it("sends the request's correlation ID on the supplier lookup, so Supplier logs it too", async () => {
    const supplierFetch = vi.fn<typeof fetch>(async () => Response.json(supplier));
    t = await createTestApp(supplierFetch);

    await http(t)
      .post('/orders')
      .set('Authorization', asRequester)
      .set('Idempotency-Key', 'trace-1')
      .set('X-Correlation-Id', 'trace-from-browser')
      .send(order)
      .expect(201);

    const init = supplierFetch.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get('x-correlation-id')).toBe('trace-from-browser');
  });

  it('reports errands per status at /metrics, counted from the database', async () => {
    t = await createTestApp();
    await http(t)
      .post('/orders')
      .set('Authorization', asRequester)
      .set('Idempotency-Key', 'count-1')
      .send(order)
      .expect(201);

    const { rows } = await t.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders WHERE status = 'PENDING_CREDIT'`,
    );
    const metrics = await http(t).get('/metrics').expect(200);

    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.text).toMatch(
      new RegExp(`foc_orders\\{[^}]*status="PENDING_CREDIT"[^}]*\\} ${rows[0]!.n}\\n`),
    );
  });

  it('times requests by route pattern, so each errand does not become its own series', async () => {
    t = await createTestApp();
    await http(t)
      .get('/orders/0b7c2c1e-6f1d-4c4e-9d53-2f1c7d0b9a11')
      .set('Authorization', asRequester);

    const metrics = await http(t).get('/metrics').expect(200);

    expect(metrics.text).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/orders\/:id"/);
    expect(metrics.text).not.toContain('0b7c2c1e-6f1d-4c4e-9d53-2f1c7d0b9a11');
  });
});
