import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAMPUS_BUILDINGS } from '../src/suppliers/campus-buildings.js';
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

const buildings = (query = '') =>
  http(t)
    .get(`/buildings${query}`)
    .set('Authorization', asStudent)
    .expect(200)
    .then((r) => r.body.items as string[]);

const create = (over: Record<string, unknown>) =>
  http(t)
    .post('/suppliers')
    .set('Authorization', asAdmin)
    .send(validSupplier(over))
    .expect(201)
    .then((r) => r.body);

describe('GET /buildings', () => {
  it('refuses an unauthenticated caller with 401', async () => {
    await http(t).get('/buildings').expect(401);
  });

  it('returns the whole campus list, sorted, whatever is in use', async () => {
    expect(await buildings()).toEqual(CAMPUS_BUILDINGS);
    expect(await buildings('?inUse=false')).toEqual(CAMPUS_BUILDINGS);
  });

  it('with inUse=true, returns only the buildings with an active supplier, in list order', async () => {
    expect(await buildings('?inUse=true')).toEqual([]);

    await create({ name: 'A', building: 'The Deck' });
    await create({ name: 'B', building: 'COM2' });
    await create({ name: 'C', building: 'COM2' });
    expect(await buildings('?inUse=true')).toEqual(['COM2', 'The Deck']);

    const library = await create({ name: 'D', building: 'Central Library' });
    expect(await buildings('?inUse=true')).toEqual(['Central Library', 'COM2', 'The Deck']);

    await http(t)
      .delete(`/suppliers/${library.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', String(library.version))
      .expect(200);
    expect(await buildings('?inUse=true')).toEqual(['COM2', 'The Deck']);
  });

  it('counts an active supplier stored in another spelling under its listed building', async () => {
    const s = await create({ name: 'Typed', building: 'Central Library' });
    await t.db.query("UPDATE suppliers SET building = 'central  library' WHERE supplier_id = $1", [
      s.supplierId,
    ]);
    expect(await buildings('?inUse=true')).toEqual(['Central Library']);
  });

  it('leaves out an active supplier stored before its building left the list', async () => {
    const s = await create({ name: 'Legacy', building: 'COM2' });
    await t.db.query("UPDATE suppliers SET building = 'COM1' WHERE supplier_id = $1", [
      s.supplierId,
    ]);
    expect(await buildings('?inUse=true')).toEqual([]);
  });
});
