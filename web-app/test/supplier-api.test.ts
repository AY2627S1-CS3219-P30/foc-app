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
