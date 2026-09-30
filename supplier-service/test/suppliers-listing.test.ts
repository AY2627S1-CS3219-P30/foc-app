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

const create = (over: Record<string, unknown>) =>
  http(t).post('/suppliers').set('Authorization', asAdmin).send(validSupplier(over)).expect(201);

const listing = (query = '') =>
  http(t)
    .get(`/suppliers${query}`)
    .set('Authorization', asStudent)
    .expect(200)
    .then((r) => r.body);

const ids = (page: { items: { supplierId: string }[] }) => page.items.map((s) => s.supplierId);

interface Listed {
  supplierId: string;
  name: string;
  type: string;
  building: string;
  updatedAt: string;
}

const SORT_KEY: Record<string, (s: Listed) => string> = {
  name: (s) => s.name.toLowerCase(),
  type: (s) => s.type,
  building: (s) => s.building.toLowerCase(),
  updatedAt: (s) => s.updatedAt,
};

/** Byte-order compare, as the SQL sorts: no locale folding beyond the explicit lower(). */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The ids in the order the listing must return: sort key, then lower-cased name, then id. */
const expectedOrder = (rows: Listed[], sort: string, order: 'asc' | 'desc') => {
  const key = SORT_KEY[sort]!;
  const sorted = [...rows].sort(
    (a, b) =>
      compare(key(a), key(b)) ||
      compare(a.name.toLowerCase(), b.name.toLowerCase()) ||
      compare(a.supplierId, b.supplierId),
  );
  if (order === 'desc') sorted.reverse();
  return sorted.map((s) => s.supplierId);
};

/** Creates `n` active suppliers with distinct name+building, returning them oldest-first. */
const seed = async (n: number, over: (i: number) => Record<string, unknown> = () => ({})) => {
  const created = [];
  for (let i = 0; i < n; i++) {
    const res = await create({
      name: `Stall ${String(i).padStart(2, '0')}`,
      building: `B${i}`,
      ...over(i),
    });
    created.push(res.body);
  }
  return created;
};

describe('the query schema clamps page and page size (never rejects)', () => {
  const parse = (q: Record<string, unknown>) => supplierListQuerySchema.parse(q);

  it('defaults to page 1, size 20, name ascending', () => {
    expect(parse({})).toMatchObject({ page: 1, pageSize: 20, sort: 'name', order: 'asc' });
  });

  it('clamps an oversized page size down to 100 and an undersized one up to 1', () => {
    expect(parse({ pageSize: '500' }).pageSize).toBe(100);
    expect(parse({ pageSize: '0' }).pageSize).toBe(1);
    expect(parse({ pageSize: '-4' }).pageSize).toBe(1);
  });

  it('clamps a page below 1 up to 1 and falls back on unparseable values', () => {
    expect(parse({ page: '0' }).page).toBe(1);
    expect(parse({ page: 'abc' }).page).toBe(1);
    expect(parse({ pageSize: 'abc' }).pageSize).toBe(20);
  });

  it('falls back to the stable default sort on an unknown sort or order', () => {
    expect(parse({ sort: 'nonsense', order: 'sideways' })).toMatchObject({
      sort: 'name',
      order: 'asc',
    });
  });
});

describe('listing shape and defaults', () => {
  it('returns a lean list item — name, type, building, image only', async () => {
    await create({ name: 'Only', building: 'COM1' });
    const page = await listing();
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(Object.keys(page.items[0]).sort()).toEqual(
      ['building', 'imageUrl', 'name', 'supplierId', 'type'].sort(),
    );
  });

  it('is a 200 empty page when nothing matches, not a 404', async () => {
    await create({ name: 'Alpha', building: 'COM1', type: 'FOOD' });
    const page = await listing('?type=PRINTING');
    expect(page).toEqual({ page: 1, pageSize: 20, total: 0, items: [] });
  });
});

describe('pagination covers the whole set exactly once', () => {
  it('pages the full set with no gaps or duplicates, ordered by name then id', async () => {
    // Shared names force the id tie-break to decide order within each name.
    const all = await seed(25, (i) => ({ name: `Stall ${i % 5}` }));

    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const body = await listing(`?page=${page}&pageSize=10`);
      expect(body.total).toBe(25);
      seen.push(...ids(body));
    }
    expect(seen).toEqual(expectedOrder(all, 'name', 'asc'));
  });

  it('sorts names case-insensitively', async () => {
    for (const name of ['TOMORO', 'he by He Brews', 'NUS Co-op', 'Nami']) {
      await create({ name, building: 'COM1' });
    }
    const page = await listing();
    expect(page.items.map((s: { name: string }) => s.name)).toEqual([
      'he by He Brews',
      'Nami',
      'NUS Co-op',
      'TOMORO',
    ]);
  });
});

describe('every sort option orders correctly and is stable across pages', () => {
  const types = ['FOOD', 'CAFE', 'PRINTING', 'SHOPPING', 'LANDMARK'] as const;
  const names = ['kopi a', 'Kopi B', 'KOPI c'];
  const buildings = ['blk A', 'Blk b', 'BLK C', 'blk D'];
  const updatedAt = (i: number) => `2026-01-0${1 + (i % 2)}T00:00:00.000Z`;
  let all: Listed[];

  beforeEach(async () => {
    // Repeated keys in mixed case force both the case folding and the
    // name-then-id tie-breaks to matter for every sort.
    const created = await seed(12, (i) => ({
      name: names[i % names.length],
      type: types[i % types.length],
      building: buildings[i % buildings.length],
    }));
    // Two shared timestamps, so updatedAt ties too.
    all = created.map((s: Listed, i: number) => ({ ...s, updatedAt: updatedAt(i) }));
    for (const at of new Set(all.map((s) => s.updatedAt))) {
      await t.db.query('UPDATE suppliers SET updated_at = $1 WHERE supplier_id = ANY($2)', [
        at,
        all.filter((s) => s.updatedAt === at).map((s) => s.supplierId),
      ]);
    }
  });

  for (const sort of ['name', 'type', 'building', 'updatedAt'] as const) {
    for (const order of ['asc', 'desc'] as const) {
      it(`sort=${sort} order=${order} orders by key, name, id and pages without gaps`, async () => {
        const expected = expectedOrder(all, sort, order);
        const full = await listing(`?sort=${sort}&order=${order}&pageSize=100`);
        expect(ids(full)).toEqual(expected);

        const paged: string[] = [];
        for (let page = 1; page <= 3; page++) {
          paged.push(...ids(await listing(`?sort=${sort}&order=${order}&page=${page}&pageSize=5`)));
        }
        expect(paged).toEqual(expected);
      });
    }
  }
});

describe('filters', () => {
  beforeEach(async () => {
    await create({ name: 'Food One', building: 'COM1', type: 'FOOD' });
    await create({ name: 'Cafe One', building: 'COM1', type: 'CAFE' });
    await create({ name: 'Food Two', building: 'COM2', type: 'FOOD' });
  });

  it('filters by type', async () => {
    const page = await listing('?type=FOOD');
    expect(page.total).toBe(2);
    expect(page.items.map((s: { name: string }) => s.name).sort()).toEqual([
      'Food One',
      'Food Two',
    ]);
  });

  it('filters by building, case-insensitively and via the same normalization as create', async () => {
    const page = await listing('?building=com1');
    expect(page.total).toBe(2);
    expect(page.items.every((s: { building: string }) => s.building === 'COM1')).toBe(true);
  });

  it('combines type and building filters', async () => {
    const page = await listing('?type=FOOD&building=COM2');
    expect(page.total).toBe(1);
    expect(page.items[0].name).toBe('Food Two');
  });
});

describe('search is case-insensitive across all four fields', () => {
  beforeEach(async () => {
    await create({ name: 'Zebra Kitchen', building: 'COM1', locationDescription: 'ground floor' });
    await create({ name: 'Plain Stall', building: 'Zebra Hall', locationDescription: 'level 2' });
    await create({
      name: 'Quiet Nook',
      building: 'COM2',
      locationDescription: 'behind the zebra mural',
    });
    await create({
      name: 'Tagged Spot',
      building: 'COM3',
      locationDescription: 'level 1',
      tags: ['zebra-friendly'],
    });
    await create({
      name: 'Unrelated',
      building: 'UTown',
      locationDescription: 'nothing here',
      tags: ['halal'],
    });
    await create({ name: '100% Juice', building: 'COM1' });
    await create({ name: 'Snack_Bar', building: 'COM1' });
    await create({ name: 'Back\\Slash', building: 'COM1' });
  });

  it('matches the term in name, building, location description or tags', async () => {
    const page = await listing('?q=ZEBRA');
    expect(page.total).toBe(4);
    expect(page.items.map((s: { name: string }) => s.name).sort()).toEqual([
      'Plain Stall',
      'Quiet Nook',
      'Tagged Spot',
      'Zebra Kitchen',
    ]);
  });

  it('returns an empty page when the term matches nothing', async () => {
    const page = await listing('?q=giraffe');
    expect(page).toMatchObject({ total: 0, items: [] });
  });

  // Unescaped, `%` and `_` would match every row and `\` would escape the trailing `%`.
  it.each([
    ['%25', '100% Juice'],
    ['_', 'Snack_Bar'],
    ['%5C', 'Back\\Slash'],
  ])('treats ?q=%s as literal text, not a LIKE wildcard', async (q, name) => {
    const page = await listing(`?q=${q}`);
    expect(page.items.map((s: { name: string }) => s.name)).toEqual([name]);
  });

  it('matches tag values, not the JSON they are stored as', async () => {
    for (const q of ['%22', '%5B', '%2C']) {
      expect((await listing(`?q=${q}`)).total).toBe(0);
    }
  });
});

describe('inactive suppliers', () => {
  it('are excluded from the listing but stay fetchable by id', async () => {
    const s = (await create({ name: 'Gone Soon', building: 'COM1' })).body;
    await http(t)
      .delete(`/suppliers/${s.supplierId}`)
      .set('Authorization', asAdmin)
      .set('If-Match', String(s.version))
      .expect(200);

    const page = await listing();
    expect(page.total).toBe(0);

    const byId = (
      await http(t).get(`/suppliers/${s.supplierId}`).set('Authorization', asStudent).expect(200)
    ).body;
    expect(byId).toMatchObject({ supplierId: s.supplierId, active: false });
  });
});
