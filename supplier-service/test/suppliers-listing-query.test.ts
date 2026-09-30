import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asAdmin,
  asStudent,
  createTestApp,
  http,
  validSupplier,
  type TestApp,
} from './helpers/app.js';
import { supplierListQuerySchema } from '../src/suppliers/validation.js';

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

const parse = (q: Record<string, unknown>) => supplierListQuerySchema.parse(q);

const list = (query: string) => http(t).get(`/suppliers${query}`).set('Authorization', asStudent);

describe('empty filters are ignored, not rejected', () => {
  it('treats an empty or whitespace-only q, building or type as unset', () => {
    for (const blank of ['', '   ']) {
      const parsed = parse({ q: blank, building: blank, type: blank });
      expect(parsed.q).toBeUndefined();
      expect(parsed.building).toBeUndefined();
      expect(parsed.type).toBeUndefined();
    }
  });

  it('returns the full list for a cleared search box and filters', async () => {
    for (const name of ['Alpha', 'Beta']) {
      await http(t)
        .post('/suppliers')
        .set('Authorization', asAdmin)
        .send(validSupplier({ name }))
        .expect(201);
    }
    const res = await list('?q=%20%20&building=&type=').expect(200);
    expect(res.body.total).toBe(2);
  });
});

describe('NUL bytes are a 422, not a 500', () => {
  it('rejects a NUL in the search term or building filter', async () => {
    for (const query of ['?q=a%00b', '?building=a%00b']) {
      const res = await list(query).expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects a NUL in a created supplier field', async () => {
    const res = await http(t)
      .post('/suppliers')
      .set('Authorization', asAdmin)
      .send(validSupplier({ name: 'a\0b', tags: ['x\0y'] }))
      .expect(422);
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual([
      'name',
      'tags.0',
    ]);
  });
});

describe('database tag shape', () => {
  it('rejects a non-array tags value', async () => {
    const created = await http(t)
      .post('/suppliers')
      .set('Authorization', asAdmin)
      .send(validSupplier())
      .expect(201);

    await expect(
      t.db.query('UPDATE suppliers SET tags = $1::jsonb WHERE supplier_id = $2', [
        '{}',
        created.body.supplierId,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'suppliers_tags_array' });
  });
});

describe('page and page size accept only plain decimal integers', () => {
  it('falls back to the default for an empty or non-decimal value', () => {
    expect(parse({ pageSize: '' }).pageSize).toBe(20);
    expect(parse({ pageSize: '0x2' }).pageSize).toBe(20);
    expect(parse({ pageSize: '1e1' }).pageSize).toBe(20);
    expect(parse({ pageSize: '2' }).pageSize).toBe(2);
  });
});

describe('repeated query keys never 500', () => {
  it('falls back to the default for repeated paging and sort keys', () => {
    expect(parse({ page: ['1', '2'], pageSize: ['5', '6'], order: ['asc', 'desc'] })).toMatchObject(
      { page: 1, pageSize: 20, order: 'asc' },
    );
  });

  it('rejects repeated filter keys with a 422', async () => {
    for (const query of ['?q=a&q=b', '?type=FOOD&type=CAFE', '?building=A&building=B']) {
      await list(query).expect(422);
    }
    await list('?page=1&page=2&sort=name&sort=type').expect(200);
  });
});

describe('sort, order and type are case-insensitive', () => {
  it('accepts any casing and trims sort and order', () => {
    expect(parse({ sort: ' UPDATEDAT ', order: ' DESC ' })).toMatchObject({
      sort: 'updatedAt',
      order: 'desc',
    });
    expect(parse({ type: 'food' }).type).toBe('FOOD');
  });
});
