import { afterAll, expect, it } from 'bun:test';
import { listSupplierDetails } from '../src/lib/supplier-api';

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

it('sends listing controls to the Supplier Service and loads full card details', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const request = input as Request;
    urls.push(request.url);
    expect(request.headers.get('authorization')).toBe('Bearer access-token');
    const response =
      urls.length === 1
        ? {
            items: [
              {
                supplierId: 'supplier-1',
                name: 'Cafe',
                type: 'CAFE',
                building: 'COM2',
                imageUrl: null,
              },
            ],
            page: 2,
            pageSize: 20,
            total: 21,
          }
        : {
            supplierId: 'supplier-1',
            name: 'Cafe',
            type: 'CAFE',
            building: 'COM2',
            floor: '1',
            locationDescription: 'Beside the foyer',
            openingHours: null,
            imageUrl: null,
          };
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await listSupplierDetails('access-token', {
    q: 'cafe',
    type: 'CAFE',
    building: 'COM2',
    sort: 'updatedAt',
    order: 'desc',
    page: 2,
    pageSize: 20,
  });
  const query = new URL(urls[0]).searchParams;
  expect(Object.fromEntries(query)).toEqual({
    q: 'cafe',
    type: 'CAFE',
    building: 'COM2',
    sort: 'updatedAt',
    order: 'desc',
    page: '2',
    pageSize: '20',
  });
  expect(urls[1]).toEndWith('/suppliers/supplier-1');
  expect(result.suppliers[0].locationDescription).toBe('Beside the foyer');
  expect(result.page.total).toBe(21);
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const summary = (supplierId: string) => ({
  supplierId,
  name: supplierId,
  type: 'CAFE',
  building: 'COM2',
  imageUrl: null,
});

const detail = (supplierId: string) => ({
  ...summary(supplierId),
  floor: '1',
  locationDescription: 'Beside the foyer',
  openingHours: null,
});

/** Lists the given ids, then answers each detail call, failing those in `failing`. */
const serve = (ids: string[], failing: string[]) => {
  globalThis.fetch = async (input) => {
    const { pathname } = new URL((input as Request).url);
    if (pathname.endsWith('/suppliers'))
      return json({ items: ids.map(summary), page: 1, pageSize: 20, total: ids.length });
    const id = pathname.split('/').pop()!;
    return failing.includes(id)
      ? json({ error: { code: 'INTERNAL', message: 'Detail failed.' } }, 500)
      : json(detail(id));
  };
};

it('keeps the cards that loaded when some detail calls fail, and counts the rest', async () => {
  serve(['a', 'b', 'c'], ['b']);
  const result = await listSupplierDetails('access-token', {});
  expect(result.suppliers.map((s) => s.supplierId)).toEqual(['a', 'c']);
  expect(result.failed).toBe(1);
});

it('fails the page when every detail call fails', async () => {
  serve(['a', 'b'], ['a', 'b']);
  await expect(listSupplierDetails('access-token', {})).rejects.toMatchObject({
    status: 500,
    message: 'Detail failed.',
  });
});

it('returns an empty page without failures when nothing is listed', async () => {
  serve([], []);
  const result = await listSupplierDetails('access-token', {});
  expect(result).toMatchObject({ suppliers: [], failed: 0 });
});

it('cancels in-flight detail calls when the signal aborts', async () => {
  const controller = new AbortController();
  const aborted: string[] = [];
  globalThis.fetch = async (input, init) => {
    const { pathname } = new URL((input as Request).url);
    if (pathname.endsWith('/suppliers'))
      return json({ items: [summary('a'), summary('b')], page: 1, pageSize: 20, total: 2 });
    queueMicrotask(() => controller.abort());
    return new Promise<Response>((_, reject) =>
      init!.signal!.addEventListener('abort', () => {
        aborted.push(pathname);
        reject(init!.signal!.reason);
      }),
    );
  };
  const listing = listSupplierDetails('access-token', {}, controller.signal);
  await expect(listing).rejects.toMatchObject({ name: 'AbortError' });
  expect(aborted).toHaveLength(2);
});

it('passes an already-aborted signal to the listing call and loads no details', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push((input as Request).url);
    init!.signal!.throwIfAborted(); // as the real fetch does
    return json({});
  };
  const controller = new AbortController();
  controller.abort();
  await expect(listSupplierDetails('access-token', {}, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(urls).toHaveLength(1);
});
