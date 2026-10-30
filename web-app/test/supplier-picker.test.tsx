import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import type { Supplier, SupplierSummary } from '../src/lib/supplier-api';

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const auth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call('test-token'),
  user: { id: 'me' },
};
const pushed: string[] = [];
let search = '';
mock.module('../src/lib/auth', () => ({ useAuth: () => auth }));
mock.module('../src/components/ResponsiveShell', () => ({
  ResponsiveShell: ({ onBack, children }: { onBack?: () => void; children: React.ReactNode }) => (
    <>
      {onBack && (
        <button type="button" onClick={onBack}>
          Back
        </button>
      )}
      {children}
    </>
  ),
}));
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => pushed.push(href) }),
  useSearchParams: () => new URLSearchParams(search),
}));
const { SupplierPicker, SUPPLIER_UNAVAILABLE } = await import('../src/components/SupplierPicker');
const { default: PickerPage } = await import('../src/app/(app)/request/new/page');
const { default: DetailsPage } = await import('../src/app/(app)/request/new/details/page');
const { default: ReviewPage } = await import('../src/app/(app)/request/new/review/page');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  pushed.length = 0;
});
afterAll(() => {
  for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'])
    delete (globalThis as Record<string, unknown>)[key];
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, correlationId: 'test' } });

const summary = (name: string, i: number): SupplierSummary => ({
  supplierId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name,
  type: 'CAFE',
  building: 'COM2',
  imageUrl: null,
});
const cafe = summary('Campus Café', 1);
const kopi = summary('Kopi Corner', 2);

/** Answers each call with `respond` and records the request URLs. */
function serve(respond: (url: URL) => Response | Promise<Response>) {
  const urls: URL[] = [];
  globalThis.fetch = (async (request: Request) => {
    const url = new URL(request.url);
    urls.push(url);
    return respond(url);
  }) as typeof fetch;
  return urls;
}
const page = (items: SupplierSummary[], total = items.length) =>
  json(200, { items, page: 1, pageSize: 20, total });

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const debounce = () => act(() => new Promise((resolve) => setTimeout(resolve, 350)));

async function render(node: React.ReactNode) {
  const container = window.document.createElement('div');
  window.document.body.replaceChildren(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(node));
  await settle();
  return { container: container as unknown as HTMLElement, root };
}
const buttons = (container: HTMLElement) => [...container.querySelectorAll('button')];
const button = (container: HTMLElement, text: string) =>
  buttons(container).find((b) => b.textContent === text)!;
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

describe('SupplierPicker', () => {
  it('lists active suppliers as buttons and hands the chosen summary to onSelect', async () => {
    const urls = serve(() => page([cafe, kopi]));
    const chosen: SupplierSummary[] = [];
    const { container, root } = await render(
      <SupplierPicker onSelect={(supplier) => chosen.push(supplier)} />,
    );
    expect(urls.map((u) => u.pathname)).toEqual(['/suppliers']);
    expect(urls[0]!.searchParams.has('q')).toBe(false);
    expect(urls[0]!.searchParams.get('page')).toBe('1');
    expect(urls[0]!.searchParams.get('pageSize')).toBe('100');
    const options = buttons(container);
    expect(options.map((b) => b.textContent)).toEqual([
      'Campus CaféCafé · COM2',
      'Kopi CornerCafé · COM2',
    ]);
    expect(options.every((b) => b.type === 'button')).toBe(true);
    await act(async () => options[1]!.click());
    expect(chosen).toEqual([kopi]);
    await act(() => root.unmount());
  });

  it('searches once the typing pauses, sending the trimmed query', async () => {
    const urls = serve((url) => page(url.searchParams.get('q') === 'kopi' ? [kopi] : [cafe, kopi]));
    const { container, root } = await render(<SupplierPicker onSelect={() => {}} />);
    const input = container.querySelector('input') as HTMLInputElement;
    await type(input, 'ko');
    await type(input, ' kopi ');
    expect(urls).toHaveLength(1);
    await debounce();
    await settle();
    expect(urls.map((u) => u.searchParams.get('q'))).toEqual([null, 'kopi']);
    expect(buttons(container).map((b) => b.textContent)).toEqual(['Kopi CornerCafé · COM2']);
    await act(() => root.unmount());
  });

  it('keeps the previous results visible while a new search loads', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    serve(async (url) => {
      if (url.searchParams.get('q') !== 'kopi') return page([cafe, kopi]);
      await held;
      return page([kopi]);
    });
    const { container, root } = await render(<SupplierPicker onSelect={() => {}} />);
    await type(container.querySelector('input') as HTMLInputElement, 'kopi');
    await debounce();
    await settle();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(buttons(container).map((b) => b.textContent)).toEqual([
      'Campus CaféCafé · COM2',
      'Kopi CornerCafé · COM2',
    ]);
    release();
    await settle();
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(buttons(container).map((b) => b.textContent)).toEqual(['Kopi CornerCafé · COM2']);
    await act(() => root.unmount());
  });

  it('says when more suppliers match than are shown', async () => {
    serve(() => page([cafe, kopi], 45));
    const { container, root } = await render(<SupplierPicker onSelect={() => {}} />);
    expect(container.textContent).toContain('Showing 2 of 45. Search to narrow them down.');
    await act(() => root.unmount());
  });

  it('appends the next page on Load more until every supplier is shown', async () => {
    const urls = serve((url) => page(url.searchParams.get('page') === '1' ? [cafe] : [kopi], 2));
    const { container, root } = await render(<SupplierPicker onSelect={() => {}} />);
    expect(container.textContent).toContain('Showing 1 of 2.');

    await act(async () => button(container, 'Load more').click());
    await settle();
    expect(urls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2']);
    expect(buttons(container).map((b) => b.textContent)).toEqual([
      'Campus CaféCafé · COM2',
      'Kopi CornerCafé · COM2',
    ]);
    expect(button(container, 'Load more')).toBeUndefined();
    await act(() => root.unmount());
  });

  it('starts again from page 1 when the search changes, dropping a late page', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const urls = serve(async (url) => {
      if (url.searchParams.get('q') === 'kopi') return page([kopi]);
      if (url.searchParams.get('page') === '2') await held;
      return page([cafe], 2);
    });
    const { container, root } = await render(<SupplierPicker onSelect={() => {}} />);
    await act(async () => button(container, 'Load more').click());
    await type(container.querySelector('input') as HTMLInputElement, 'kopi');
    await debounce();
    await settle();
    release();
    await settle();

    expect(urls.map((u) => [u.searchParams.get('q'), u.searchParams.get('page')])).toEqual([
      [null, '1'],
      [null, '2'],
      ['kopi', '1'],
    ]);
    expect(buttons(container).map((b) => b.textContent)).toEqual(['Kopi CornerCafé · COM2']);
    await act(() => root.unmount());
  });

  it('shows an empty state when nothing matches', async () => {
    serve(() => page([]));
    const { container, root } = await render(<SupplierPicker onSelect={() => {}} />);
    expect(container.textContent).toContain('No pickup points found');
    expect(buttons(container)).toHaveLength(0);
    await act(() => root.unmount());
  });

  it('shows the error and loads again on retry', async () => {
    let fail = true;
    const urls = serve(() =>
      fail ? failure(500, 'INTERNAL', 'Supplier Service is down.') : page([cafe]),
    );
    const { container, root } = await render(<SupplierPicker onSelect={() => {}} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Supplier Service is down.',
    );
    fail = false;
    await act(async () => button(container, 'Try again').click());
    await settle();
    expect(urls).toHaveLength(2);
    expect(buttons(container).map((b) => b.textContent)).toEqual(['Campus CaféCafé · COM2']);
    await act(() => root.unmount());
  });

  it('leads back to the feed from the picker page', async () => {
    serve(() => page([cafe]));
    const { container, root } = await render(<PickerPage />);
    await act(async () => button(container, 'Back').click());
    expect(pushed).toEqual(['/feed']);
    await act(() => root.unmount());
  });
});

describe('details step', () => {
  const detail = (active: boolean): Supplier => ({
    ...cafe,
    floor: '1',
    locationDescription: 'By the entrance',
    openingHours: null,
    latitude: null,
    longitude: null,
    tags: null,
    active,
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  async function renderDetails(respond: () => Response, supplierId = cafe.supplierId) {
    search = `supplierId=${supplierId}`;
    const urls = serve(respond);
    const rendered = await render(<DetailsPage />);
    expect(urls.map((u) => u.pathname)).toEqual([`/suppliers/${supplierId}`]);
    return rendered;
  }
  const alert = (container: HTMLElement) => container.querySelector('[role="alert"]')?.textContent;

  it('explains a deactivated supplier and leads back to the picker', async () => {
    const { container, root } = await renderDetails(() => json(200, detail(false)));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(SUPPLIER_UNAVAILABLE);
    expect(container.querySelector('textarea')).toBeNull();
    await act(async () => button(container, 'Back to pickup points').click());
    expect(pushed).toEqual(['/request/new']);
    await act(() => root.unmount());
  });

  it('explains a supplier that no longer exists', async () => {
    const { container, root } = await renderDetails(() =>
      failure(404, 'NOT_FOUND', 'Supplier not found.'),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(SUPPLIER_UNAVAILABLE);
    await act(() => root.unmount());
  });

  it('shows the form for an active supplier', async () => {
    const { container, root } = await renderDetails(() => json(200, detail(true)));
    expect(container.textContent).toContain('Campus Café');
    expect(container.textContent).toContain('COM2, floor 1');
    expect(container.textContent).not.toContain(SUPPLIER_UNAVAILABLE);
    await act(() => root.unmount());
  });

  it('explains a missing supplierId without calling the service', async () => {
    search = '';
    const urls = serve(() => json(200, detail(true)));
    const { container, root } = await render(<DetailsPage />);
    expect(urls).toHaveLength(0);
    expect(alert(container)).toContain(SUPPLIER_UNAVAILABLE);
    await act(() => root.unmount());
  });

  it('explains a malformed supplierId the service refuses', async () => {
    const { container, root } = await renderDetails(
      () =>
        json(422, {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'One or more fields are invalid.',
            correlationId: 'test',
            details: [{ field: 'id', code: 'INVALID_FORMAT', message: 'Invalid UUID' }],
          },
        }),
      'not-a-uuid',
    );
    expect(alert(container)).toContain(SUPPLIER_UNAVAILABLE);
    await act(() => root.unmount());
  });

  it('shows any other 4xx as an error, not a withdrawn supplier', async () => {
    const { container, root } = await renderDetails(() =>
      failure(400, 'BAD_REQUEST', 'The request was malformed.'),
    );
    expect(alert(container)).toContain('The request was malformed.');
    expect(container.textContent).not.toContain(SUPPLIER_UNAVAILABLE);
    expect(button(container, 'Try again')).toBeDefined();
    await act(() => root.unmount());
  });

  it('leads back to the picker', async () => {
    const { container, root } = await renderDetails(() => json(200, detail(true)));
    await act(async () => button(container, 'Back').click());
    expect(pushed).toEqual(['/request/new']);
    await act(() => root.unmount());
  });
});

describe('review step', () => {
  async function renderReview(respond: () => Response | Promise<Response>) {
    search = `supplierId=${cafe.supplierId}`;
    window.happyDOM.setURL(`http://localhost:3000/request/new/review?${search}`);
    serve(respond);
    return render(<ReviewPage />);
  }

  it('leads back to the details step for the same supplier while the pickup point is loading', async () => {
    const { container, root } = await renderReview(() => new Promise<Response>(() => {}));
    expect(container.textContent).toContain('Loading your request');
    await act(async () => button(container, 'Back').click());
    expect(pushed).toEqual([`/request/new/details?supplierId=${cafe.supplierId}`]);
    await act(() => root.unmount());
  });

  it('leads back to the details step when the pickup point could not load', async () => {
    const { container, root } = await renderReview(() =>
      failure(503, 'SUPPLIER_SERVICE_UNAVAILABLE', 'Try again shortly.'),
    );
    expect(container.textContent).toContain('Could not load the pickup point');
    await act(async () => button(container, 'Back').click());
    expect(pushed).toEqual([`/request/new/details?supplierId=${cafe.supplierId}`]);
    await act(() => root.unmount());
  });
});
