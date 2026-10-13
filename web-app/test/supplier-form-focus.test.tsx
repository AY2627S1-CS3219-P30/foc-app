import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import type { Supplier } from '../src/lib/supplier-api';

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

mock.module('../src/lib/auth', () => ({
  useAuth: () => ({
    authed: <T,>(call: (token: string) => Promise<T>) => call('token'),
    user: { roles: ['ADMIN'] },
  }),
}));
mock.module('../src/components/ResponsiveShell', () => ({
  ResponsiveShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const { default: SuppliersPage } = await import('../src/app/(app)/suppliers/page');

const base: Supplier = {
  supplierId: '88c89763-5789-452e-9d19-8d06ed42f01f',
  name: 'Campus Café',
  type: 'CAFE',
  building: 'COM2',
  floor: '1',
  locationDescription: 'By the entrance',
  openingHours: [{ day: 'MON', opens: '09:00', closes: '18:00' }],
  latitude: null,
  longitude: null,
  imageUrl: null,
  tags: null,
  active: true,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const second: Supplier = {
  ...base,
  supplierId: '0b8f4f2e-3f7e-4c1e-9a55-6f0e6a1f2c3d',
  name: 'Science Canteen',
};

/** A supplier service holding two suppliers; a PUT bumps the version, like the real one. */
function fakeService() {
  const suppliers = new Map([base, second].map((s) => [s.supplierId, { ...s }]));
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  return async (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/suppliers' && request.method === 'GET')
      return json(200, {
        items: [...suppliers.values()].map(({ supplierId, name }) => ({ supplierId, name })),
        page: 1,
        pageSize: 20,
        total: suppliers.size,
      });
    const current = suppliers.get(pathname.split('/').pop()!)!;
    if (request.method === 'PUT') {
      const updated = { ...current, ...(await request.json()), version: current.version + 1 };
      suppliers.set(current.supplierId, updated);
      return json(200, updated);
    }
    return json(200, current);
  };
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const buttons = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === text);
const typeName = (container: HTMLElement, value: string) =>
  act(() => {
    const input = container.querySelector('form input') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const active = () => window.document.activeElement as unknown as HTMLElement | null;
const formHeading = (container: HTMLElement) => container.querySelector('form h2');

describe('supplier form focus', () => {
  const realFetch = globalThis.fetch;
  const realConfirm = window.confirm;
  const proto = window.HTMLElement.prototype as unknown as { scrollIntoView: unknown };
  const realScroll = proto.scrollIntoView;
  let scrolled: { element: Element; options: ScrollIntoViewOptions }[];
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    scrolled = [];
    proto.scrollIntoView = function (this: Element, options: ScrollIntoViewOptions) {
      scrolled.push({ element: this, options });
    };
    globalThis.fetch = fakeService() as unknown as typeof fetch;
    container = window.document.createElement('div') as unknown as HTMLElement;
    window.document.body.replaceChildren(container as never);
    root = createRoot(container);
    await act(() => root.render(<SuppliersPage />));
    await settle();
    await settle();
  });

  afterEach(async () => {
    await act(() => root.unmount());
    globalThis.fetch = realFetch;
    window.confirm = realConfirm;
    proto.scrollIntoView = realScroll;
  });

  afterAll(() => {
    for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'])
      delete (globalThis as Record<string, unknown>)[key];
  });

  it('focuses and scrolls to the form heading on Edit, and Cancel returns to that Edit button', async () => {
    const edit = buttons(container, 'Edit')[1];
    await act(async () => edit.click());
    const heading = formHeading(container);
    expect(heading?.textContent).toBe('Edit Science Canteen');
    expect(active()).toBe(heading as HTMLElement);
    expect(scrolled.map((s) => s.element)).toEqual([heading!]);
    expect(scrolled[0].options.block).toBe('start');

    await act(async () => buttons(container, 'Cancel')[0].click());
    expect(container.querySelector('form')).toBeNull();
    expect(active()).toBe(edit);
  });

  it('returns focus to Add supplier when a new supplier form is cancelled', async () => {
    const add = buttons(container, 'Add supplier')[0];
    await act(async () => add.click());
    expect(active()).toBe(formHeading(container) as HTMLElement);
    await act(async () => buttons(container, 'Cancel')[0].click());
    expect(active()).toBe(add);
  });

  it('asks before discarding unsaved changes, and keeps the form if declined', async () => {
    const asked: string[] = [];
    let answer = false;
    window.confirm = (message?: string) => {
      asked.push(message ?? '');
      return answer;
    };
    await act(async () => buttons(container, 'Edit')[0].click());
    // Switching from an untouched form doesn't ask.
    await act(async () => buttons(container, 'Edit')[1].click());
    expect(asked).toEqual([]);
    expect(formHeading(container)?.textContent).toBe('Edit Science Canteen');

    await typeName(container, 'Renamed');
    await act(async () => buttons(container, 'Add supplier')[0].click());
    expect(asked).toEqual(['Discard your changes?']);
    expect(formHeading(container)?.textContent).toBe('Edit Science Canteen');
    expect((container.querySelector('form input') as HTMLInputElement).value).toBe('Renamed');

    answer = true;
    await act(async () => buttons(container, 'Add supplier')[0].click());
    expect(asked).toHaveLength(2);
    expect(formHeading(container)?.textContent).toBe('Add supplier');
    expect(active()).toBe(formHeading(container) as HTMLElement);
  });

  it('after saving an edit, focuses the reloaded card heading for that supplier', async () => {
    await act(async () => buttons(container, 'Edit')[1].click());
    await typeName(container, 'Science Canteen 2');
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    await settle();
    expect(container.querySelector('form')).toBeNull();
    expect(active()?.tagName).toBe('H2');
    expect(active()?.textContent).toBe('Science Canteen 2');
  });
});
