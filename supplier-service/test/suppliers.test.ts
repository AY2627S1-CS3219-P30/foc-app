import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
      building: 'COM1',
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

  it('refuses a case-insensitive duplicate of name+building among active suppliers', async () => {
    await create(validSupplier({ name: 'Starbucks', building: 'YIH' })).expect(201);
    // Same building, different case → duplicate.
    const dup = await create(validSupplier({ name: 'STARBUCKS', building: 'YIH' })).expect(422);
    expect((dup.body.error.details as { code: string }[])[0]!.code).toBe('DUPLICATE_NAME_BUILDING');
    // Same name, different building → allowed.
    await create(validSupplier({ name: 'Starbucks', building: 'UTown' })).expect(201);
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
  it('excludes a deactivated supplier from listings but keeps it fetchable by id', async () => {
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
  });

  it('frees the name+building for reuse once deactivated, and is idempotent', async () => {
    const created = (await create(validSupplier({ name: 'Kopi', building: 'COM1' })).expect(201))
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
    await create(validSupplier({ name: 'Kopi', building: 'COM1' })).expect(201);
  });

  it('requires If-Match and refuses a stale version', async () => {
    const created = (await create(validSupplier({ name: 'Locked', building: 'COM1' })).expect(201))
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
