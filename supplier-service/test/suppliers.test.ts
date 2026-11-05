import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DAYS } from '../src/suppliers/types.js';
import { MAX_PERIODS_PER_DAY } from '../src/suppliers/validation.js';
import {
  asAdmin,
  asStudent,
  createTestApp,
  http,
  validSupplier,
  type TestApp,
} from './helpers/app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.exec('TRUNCATE supplier_idempotency_keys, suppliers RESTART IDENTITY CASCADE');
});

const countSuppliers = async (): Promise<number> =>
  Number((await t.db.query<{ n: string }>('SELECT count(*) AS n FROM suppliers')).rows[0]!.n);

const create = (body: unknown, auth = asAdmin, headers: Record<string, string> = {}) => {
  let req = http(t).post('/suppliers').set('Authorization', auth);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body as object);
};

describe('permissions (enforced server-side)', () => {
  it('lets an admin create a supplier (201) and returns it', async () => {
    const res = await create(validSupplier()).expect(201);
    expect(res.body).toMatchObject({
      name: 'Test Kopitiam',
      type: 'FOOD',
      active: true,
      version: 1,
    });
    expect(res.body.supplierId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a student POST with 403 and writes nothing', async () => {
    const denied = await create(validSupplier(), asStudent).expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    expect(await countSuppliers()).toBe(0);
  });

  it('refuses an unauthenticated POST with 401', async () => {
    const res = await http(t).post('/suppliers').send(validSupplier()).expect(401);
    expect(res.body.error.code).toBe('TOKEN_MISSING');
  });

  it('lets a student list and view but not update or deactivate', async () => {
    const created = (await create(validSupplier()).expect(201)).body;
    await http(t).get('/suppliers').set('Authorization', asStudent).expect(200);
    await http(t)
      .get(`/suppliers/${created.supplierId}`)
      .set('Authorization', asStudent)
      .expect(200);
    await http(t)
      .put(`/suppliers/${created.supplierId}`)
      .set('Authorization', asStudent)
      .set('If-Match', '1')
      .send({ floor: '2' })
      .expect(403);
    await http(t)
      .delete(`/suppliers/${created.supplierId}`)
      .set('Authorization', asStudent)
      .expect(403);
  });
});

describe('validation (422, every field at once)', () => {
  it('reports an invalid type, a blank required field and a malformed coordinate together', async () => {
    const res = await create({
      name: '   ',
      type: 'GROCERIES',
      building: 'COM3',
      floor: '1',
      locationDescription: 'x',
      latitude: 999,
      longitude: 103.7,
    }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const fields = (res.body.error.details as { field: string }[]).map((d) => d.field).sort();
    expect(fields).toEqual(['latitude', 'name', 'type']);
  });

  it('rejects latitude without longitude', async () => {
    const res = await create(validSupplier({ latitude: 1.3, longitude: undefined })).expect(422);
    expect((res.body.error.details as { field: string }[])[0]!.field).toBe('longitude');
  });

  it('rejects one coordinate null while the other is a number (create)', async () => {
    const res = await create(validSupplier({ latitude: null, longitude: 103.5 })).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect((res.body.error.details as { field: string }[])[0]!.field).toBe('latitude');
  });

  it('rejects an unknown field', async () => {
    const res = await create(validSupplier({ surprise: true })).expect(422);
    expect(res.body.error.details).toEqual([
      { field: 'surprise', code: 'UNKNOWN_FIELD', message: expect.any(String) },
    ]);
  });

  it('refuses a building off the campus list and writes nothing', async () => {
    const res = await create(validSupplier({ building: 'Atlantis' })).expect(422);
    expect(res.body.error.details).toEqual([
      { field: 'building', code: 'UNKNOWN_BUILDING', message: expect.any(String) },
    ]);
    expect(await countSuppliers()).toBe(0);
  });

  it('stores the campus spelling of a building given in any case or spacing', async () => {
    const res = await create(validSupplier({ building: ' central   LIBRARY' })).expect(201);
    expect(res.body.building).toBe('Central Library');
  });

  it('refuses a case-insensitive duplicate of name+building among active suppliers', async () => {
    await create(validSupplier({ name: 'Starbucks', building: 'Yusof Ishak House' })).expect(201);
    // Same building, different case → duplicate.
    const dup = await create(
      validSupplier({ name: 'STARBUCKS', building: 'Yusof Ishak House' }),
    ).expect(422);
    expect((dup.body.error.details as { code: string }[])[0]!.code).toBe('DUPLICATE_NAME_BUILDING');
    // Same name, different building → allowed.
    await create(validSupplier({ name: 'Starbucks', building: 'University Town' })).expect(201);
  });
});

describe('opening hours (SS-FR1.1.3)', () => {
  const period = (day: string, opens: string, closes: string) => ({ day, opens, closes });
  const withHours = (openingHours: unknown) => create({ ...validSupplier(), openingHours });

  it('stores a midday break, a closed day, an all-day day and a late close unchanged', async () => {
    const openingHours = [
      period('MON', '08:00', '12:00'),
      period('MON', '13:00', '20:00'),
      period('TUE', '00:00', '23:59'),
      period('WED', '18:00', '02:00'),
    ];
    const created = await withHours(openingHours).expect(201);

    const read = await http(t)
      .get(`/suppliers/${created.body.supplierId}`)
      .set('Authorization', asStudent)
      .expect(200);
    expect(read.body.openingHours).toEqual(openingHours);
  });

  it('lets one period end as the next begins', async () => {
    await withHours([period('MON', '08:00', '12:00'), period('MON', '12:00', '14:00')]).expect(201);
  });

  it('takes periods in any order, and stores them by day, then opening time', async () => {
    const created = await withHours([
      period('TUE', '13:00', '20:00'),
      period('MON', '13:00', '20:00'),
      period('TUE', '08:00', '12:00'),
      period('MON', '08:00', '12:00'),
    ]).expect(201);

    expect(created.body.openingHours).toEqual([
      period('MON', '08:00', '12:00'),
      period('MON', '13:00', '20:00'),
      period('TUE', '08:00', '12:00'),
      period('TUE', '13:00', '20:00'),
    ]);
  });

  it('refuses periods on one day that overlap, naming the entry, and writes nothing', async () => {
    const res = await withHours([
      period('TUE', '08:00', '12:00'),
      period('MON', '08:00', '12:00'),
      period('MON', '11:00', '13:00'),
    ]).expect(422);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ field: 'openingHours.2', code: 'OVERLAPPING_HOURS' }),
    ]);
    expect(res.body.error.details[0].message).toContain('MON');
    expect(await countSuppliers()).toBe(0);
  });

  it('refuses a malformed time and an unknown day, naming each, and writes nothing', async () => {
    const res = await withHours([
      period('MON', '8am', '12:00'),
      period('FUNDAY', '08:00', '12:00'),
    ]).expect(422);
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(['openingHours.0.opens', 'openingHours.1.day']);
    expect(await countSuppliers()).toBe(0);
  });

  it('does not hold a refused period against the ones after it', async () => {
    const res = await withHours([
      period('MON', '08:00', '12:00'),
      period('MON', '11:00', '13:00'),
      period('MON', '12:30', '14:00'),
    ]);
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual([
      'openingHours.1',
    ]);
  });

  it('refuses the same period twice', async () => {
    const res = await withHours([period('MON', '08:00', '12:00'), period('MON', '08:00', '12:00')]);
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].field).toBe('openingHours.1');
  });

  it('refuses a period that opens after one running past midnight', async () => {
    const res = await withHours([period('MON', '18:00', '02:00'), period('MON', '20:00', '22:00')]);
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('OVERLAPPING_HOURS');
  });

  it('refuses a period the night before runs into, against the entry that comes later', async () => {
    const res = await withHours([period('MON', '20:00', '03:00'), period('TUE', '01:00', '05:00')]);
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ field: 'openingHours.1', code: 'OVERLAPPING_HOURS' }),
    ]);

    const reversed = await withHours([
      period('TUE', '01:00', '05:00'),
      period('MON', '20:00', '03:00'),
    ]);
    expect(reversed.status).toBe(422);
    expect(reversed.body.error.details[0].field).toBe('openingHours.1');
  });

  it('runs a late Sunday into Monday', async () => {
    const res = await withHours([period('SUN', '22:00', '04:00'), period('MON', '00:00', '06:00')]);
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('OVERLAPPING_HOURS');
  });

  it('allows a late close that ends as the next day opens', async () => {
    await withHours([period('MON', '20:00', '03:00'), period('TUE', '03:00', '05:00')]).expect(201);
  });

  it('refuses a period that opens and closes at the same time, and blames only it', async () => {
    const res = await withHours([period('MON', '12:00', '12:00'), period('MON', '14:00', '18:00')]);
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ field: 'openingHours.0', code: 'EMPTY_PERIOD' }),
    ]);
  });

  it('counts 23:59 as the end of the day, as the catalogue writes all day', async () => {
    const res = await withHours([period('MON', '00:00', '23:59'), period('MON', '23:59', '06:00')]);
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('OVERLAPPING_HOURS');

    await withHours([period('MON', '00:00', '23:59'), period('TUE', '00:00', '23:59')]).expect(201);
  });

  it('allows a period before one running past midnight', async () => {
    await withHours([period('MON', '08:00', '12:00'), period('MON', '18:00', '02:00')]).expect(201);
  });

  it('refuses more than four periods on a day', async () => {
    const res = await withHours(
      ['08', '10', '12', '14', '16'].map((hour) => period('MON', `${hour}:00`, `${hour}:30`)),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].field).toBe('openingHours.4');
  });

  it('publishes the limit it applies', () => {
    const contract = readFileSync(
      new URL('../../contracts/supplier-service.openapi.yaml', import.meta.url),
      'utf8',
    );
    const maxItems = /openingHours:\s+type: \[array, 'null'\]\s+maxItems: (\d+)/.exec(
      contract,
    )?.[1];
    expect(Number(maxItems)).toBe(DAYS.length * MAX_PERIODS_PER_DAY);
    expect(contract).toContain(`Up to ${MAX_PERIODS_PER_DAY} periods a day`);
  });

  it('accepts four periods on all seven days', async () => {
    const openingHours = DAYS.flatMap((day) =>
      ['08', '10', '12', '14'].map((hour) => period(day, `${hour}:00`, `${hour}:30`)),
    );
    await withHours(openingHours).expect(201);
  });

  it('applies the same rule on an update, and keeps the hours it refused to change', async () => {
    const created = await withHours([period('MON', '08:00', '12:00')]).expect(201);
    const res = await http(t)
      .put(`/suppliers/${created.body.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', '1')
      .send({ openingHours: [period('MON', '08:00', '12:00'), period('MON', '09:00', '10:00')] });
    expect(res.status).toBe(422);

    const read = await http(t)
      .get(`/suppliers/${created.body.supplierId}`)
      .set('Authorization', asAdmin)
      .expect(200);
    expect(read.body.openingHours).toEqual([period('MON', '08:00', '12:00')]);
  });
});

describe('idempotent create (Idempotency-Key)', () => {
  it('returns the original supplier on a repeat, not a 409 or a second row', async () => {
    const first = await create(validSupplier(), asAdmin, { 'Idempotency-Key': 'abc-123' }).expect(
      201,
    );
    const repeat = await create(validSupplier(), asAdmin, { 'Idempotency-Key': 'abc-123' }).expect(
      200,
    );
    expect(repeat.body).toEqual(first.body);
    expect(await countSuppliers()).toBe(1);
  });

  it('a different key with the same name+building still hits the duplicate rule', async () => {
    await create(validSupplier(), asAdmin, { 'Idempotency-Key': 'key-1' }).expect(201);
    await create(validSupplier(), asAdmin, { 'Idempotency-Key': 'key-2' }).expect(422);
  });

  it('rejects a key over 200 characters with 400 and creates nothing', async () => {
    await create(validSupplier(), asAdmin, { 'Idempotency-Key': 'k'.repeat(200) }).expect(201);
    const res = await create(validSupplier({ name: 'Other' }), asAdmin, {
      'Idempotency-Key': 'k'.repeat(201),
    }).expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(await countSuppliers()).toBe(1);
  });
});

describe('optimistic locking (If-Match / version)', () => {
  it('updates at the current version and bumps it', async () => {
    const created = (await create(validSupplier()).expect(201)).body;
    const res = await http(t)
      .put(`/suppliers/${created.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', String(created.version))
      .send({ floor: '5', locationDescription: 'Moved upstairs' })
      .expect(200);
    expect(res.body).toMatchObject({
      floor: '5',
      locationDescription: 'Moved upstairs',
      version: 2,
    });
    expect(res.headers.etag).toBe('"2"');
  });

  it('rejects clearing one coordinate while sending a value for the other (422, not 500)', async () => {
    const created = (await create(validSupplier({ latitude: 1.3, longitude: 103.7 })).expect(201))
      .body;
    const res = await http(t)
      .put(`/suppliers/${created.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', String(created.version))
      .send({ latitude: null, longitude: 103.5 })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect((res.body.error.details as { field: string }[])[0]!.field).toBe('latitude');
  });

  it('rejects a stale version with 412 and changes nothing', async () => {
    const created = (await create(validSupplier()).expect(201)).body;
    await http(t)
      .put(`/suppliers/${created.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', '1')
      .send({ floor: '2' })
      .expect(200); // now at version 2
    const stale = await http(t)
      .put(`/suppliers/${created.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', '1') // stale
      .send({ floor: '9' })
      .expect(412);
    expect(stale.body.error.code).toBe('STALE_VERSION');
    const now = (
      await http(t).get(`/suppliers/${created.supplierId}`).set('Authorization', asAdmin)
    ).body;
    expect(now.floor).toBe('2'); // the stale edit did not land
    expect(now.version).toBe(2);
  });

  it('refuses moving a supplier to a building off the campus list', async () => {
    const created = (await create(validSupplier()).expect(201)).body;
    const res = await http(t)
      .put(`/suppliers/${created.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', String(created.version))
      .send({ building: 'Atlantis' })
      .expect(422);
    expect(res.body.error.details).toEqual([
      { field: 'building', code: 'UNKNOWN_BUILDING', message: expect.any(String) },
    ]);
    const now = (
      await http(t).get(`/suppliers/${created.supplierId}`).set('Authorization', asAdmin)
    ).body;
    expect(now).toMatchObject({ building: 'COM3', version: 1 });
  });

  it('requires an If-Match header', async () => {
    const created = (await create(validSupplier()).expect(201)).body;
    const res = await http(t)
      .put(`/suppliers/${created.supplierId}`)
      .set('Authorization', asAdmin)
      .send({ floor: '2' })
      .expect(428);
    expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
  });

  it('404s an update to a supplier that does not exist', async () => {
    await http(t)
      .put('/suppliers/11111111-1111-4111-8111-111111111111')
      .set('Authorization', asAdmin)
      .set('If-Match', '1')
      .send({ floor: '2' })
      .expect(404);
  });
});

describe('soft deactivation', () => {
  it('excludes a deactivated supplier from listings but keeps its row, fetchable by id', async () => {
    const created = (await create(validSupplier()).expect(201)).body;
    await http(t)
      .delete(`/suppliers/${created.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', String(created.version))
      .expect(200);

    const list = (await http(t).get('/suppliers').set('Authorization', asAdmin).expect(200)).body;
    expect(
      list.items.find((s: { supplierId: string }) => s.supplierId === created.supplierId),
    ).toBeUndefined();

    const byId = (
      await http(t)
        .get(`/suppliers/${created.supplierId}`)
        .set('Authorization', asAdmin)
        .expect(200)
    ).body;
    expect(byId).toMatchObject({ supplierId: created.supplierId, active: false });
    expect(await countSuppliers()).toBe(1);
  });

  it('frees the name+building for reuse once deactivated, and is idempotent', async () => {
    const created = (await create(validSupplier({ name: 'Kopi', building: 'COM3' })).expect(201))
      .body;
    const deactivated = (
      await http(t)
        .delete(`/suppliers/${created.supplierId}`)
        .set('Authorization', asAdmin)
        .set('If-Match', String(created.version))
        .expect(200)
    ).body;
    // deactivating again at the now-current version is a no-op, not an error
    await http(t)
      .delete(`/suppliers/${created.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', String(deactivated.version))
      .expect(200);
    // the freed name can be created again while the old row remains fetchable
    await create(validSupplier({ name: 'Kopi', building: 'COM3' })).expect(201);
  });

  it('refuses a retry at the pre-deactivation version as stale (412)', async () => {
    const created = (await create(validSupplier({ name: 'Retry', building: 'COM3' })).expect(201))
      .body;
    const del = () =>
      http(t)
        .delete(`/suppliers/${created.supplierId}`)
        .set('Authorization', asAdmin)
        .set('If-Match', String(created.version));
    await del().expect(200);
    const retry = await del().expect(412);
    expect(retry.body.error.code).toBe('STALE_VERSION');
  });

  it('requires If-Match and refuses a stale version', async () => {
    const created = (await create(validSupplier({ name: 'Locked', building: 'COM3' })).expect(201))
      .body;
    // No If-Match: a deactivation must carry the version it last saw.
    await http(t)
      .delete(`/suppliers/${created.supplierId}`)
      .set('Authorization', asAdmin)
      .expect(428);
    // A stale version is refused rather than silently deleting a newer supplier.
    await http(t)
      .delete(`/suppliers/${created.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', String(created.version + 1))
      .expect(412);
    // The supplier is untouched: still active and listable.
    const byId = (
      await http(t)
        .get(`/suppliers/${created.supplierId}`)
        .set('Authorization', asAdmin)
        .expect(200)
    ).body;
    expect(byId).toMatchObject({ active: true, version: created.version });
  });
});
