import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import type { Supplier } from '../src/lib/supplier-api';
import { BUILDINGS } from '../src/lib/supplier-display';

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

/** Tests switch `user.roles`; `authed` stays one function, as the real hook's is memoised. */
const auth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call('test-token'),
  user: { roles: ['ADMIN'] },
};
mock.module('../src/lib/auth', () => ({ useAuth: () => auth }));
/** The navigation the page last gave its shell. */
let shellNav: Array<{ href: string; label: string }> = [];
mock.module('../src/components/ResponsiveShell', () => ({
  ResponsiveShell: ({
    children,
    navItems,
  }: {
    children: React.ReactNode;
    navItems: Array<{ href: string; label: string }>;
  }) => {
    shellNav = navItems;
    return <>{children}</>;
  },
}));
const { default: SuppliersPage } = await import('../src/app/(app)/suppliers/page');

afterAll(() => {
  for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'])
    delete (globalThis as Record<string, unknown>)[key];
});

const makeSupplier = (i: number): Supplier => ({
  supplierId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `Supplier ${String(i).padStart(2, '0')}`,
  type: 'FOOD',
  building: 'COM2',
  floor: '1',
  locationDescription: `Counter ${i}`,
  openingHours: [{ day: 'MON', opens: '09:00', closes: '18:00' }],
  latitude: null,
  longitude: null,
  imageUrl: null,
  tags: null,
  active: true,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  ifMatch: string | null;
  idempotencyKey: string | null;
  authorization: string | null;
  body?: unknown;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message: string, details?: unknown[]) =>
  json(status, { error: { code, message, correlationId: 'test', ...(details && { details }) } });

/**
 * The Supplier Service, in memory, behind `fetch`: the page's real openapi-fetch client and
 * ApiError mapping run against it. Writes follow the service's rules (If-Match must equal the
 * current version, which each write bumps). `override` answers a call before the default handling.
 */
function fakeService(count: number) {
  const suppliers = Array.from({ length: count }, (_, i) => makeSupplier(i + 1));
  const calls: Call[] = [];
  /** Creates by Idempotency-Key, as the service keeps them: a replay must send the same body. */
  const created = new Map<string, { body: string; supplier: Supplier }>();
  const service = {
    suppliers,
    calls,
    override: undefined as ((call: Call) => Response | undefined) | undefined,
    lists: () => calls.filter((c) => c.method === 'GET' && c.path === '/suppliers'),
    writes: (method: string) => calls.filter((c) => c.method === method),
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const text = request.method === 'GET' ? '' : await request.text();
      const call: Call = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        ifMatch: request.headers.get('if-match'),
        idempotencyKey: request.headers.get('idempotency-key'),
        authorization: request.headers.get('authorization'),
        ...(text && { body: JSON.parse(text) }),
      };
      calls.push(call);
      const overridden = service.override?.(call);
      if (overridden) return overridden;

      if (call.method === 'GET' && call.path === '/suppliers') {
        const page = Number(call.query.get('page'));
        const pageSize = Number(call.query.get('pageSize'));
        const items = suppliers
          .slice((page - 1) * pageSize, page * pageSize)
          .map(({ supplierId, name, type, building, imageUrl }) => ({
            supplierId,
            name,
            type,
            building,
            imageUrl,
          }));
        return json(200, { items, page, pageSize, total: suppliers.length });
      }
      if (call.method === 'POST' && call.path === '/suppliers') {
        const body = JSON.stringify(call.body);
        const replay = call.idempotencyKey ? created.get(call.idempotencyKey) : undefined;
        if (replay && replay.body !== body)
          return failure(422, 'IDEMPOTENCY_KEY_REUSED', 'This key was used for another supplier.');
        if (replay) return json(200, replay.supplier);
        const supplier = {
          ...makeSupplier(suppliers.length + 100),
          ...(call.body as object),
        } as Supplier;
        suppliers.push(supplier);
        if (call.idempotencyKey) created.set(call.idempotencyKey, { body, supplier });
        return json(201, supplier);
      }
      const index = suppliers.findIndex((s) => call.path === `/suppliers/${s.supplierId}`);
      if (index < 0) return failure(404, 'NOT_FOUND', 'Supplier not found.');
      const current = suppliers[index]!;
      if (call.method === 'GET') return json(200, current);
      if (call.ifMatch !== String(current.version))
        return failure(412, 'VERSION_CONFLICT', 'Someone else changed this supplier.');
      if (call.method === 'DELETE') {
        suppliers.splice(index, 1);
        return json(200, { ...current, active: false, version: current.version + 1 });
      }
      const updated = { ...current, ...(call.body as object), version: current.version + 1 };
      suppliers[index] = updated;
      return json(200, updated);
    },
  };
  return service;
}

const realFetch = globalThis.fetch;
let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  auth.user = { roles: ['ADMIN'] };
});

afterEach(async () => {
  if (mounted) await act(() => mounted!.unmount());
  mounted = null;
  globalThis.fetch = realFetch;
});

/** Lets pending fetches, state updates and effects run. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const flush = async () => {
  for (let i = 0; i < 4; i++) await settle();
};

async function renderPage(service: ReturnType<typeof fakeService>) {
  globalThis.fetch = ((request: Request) => service.fetch(request)) as typeof fetch;
  const container = window.document.createElement('div');
  window.document.body.replaceChildren(container);
  const root = createRoot(container as unknown as Element);
  mounted = root;
  await act(() => root.render(<SuppliersPage />));
  await flush();
  return container as unknown as HTMLElement;
}

const buttons = (scope: ParentNode, text: string) =>
  Array.from(scope.querySelectorAll('button')).filter((b) => b.textContent === text);
const button = (scope: ParentNode, text: string) => {
  const found = buttons(scope, text)[0];
  if (!found) throw new Error(`No "${text}" button`);
  return found;
};
const click = async (target: HTMLElement) => {
  await act(async () => target.click());
  await flush();
};

/** The control a `Field` labels, by its visible label (without the required marker). */
function control<T extends HTMLElement>(scope: ParentNode, label: string): T {
  const found = Array.from(scope.querySelectorAll('label')).find(
    (l) => l.textContent?.replace(/\s*\*$/, '') === label,
  );
  if (!found) throw new Error(`No field labelled "${label}"`);
  return window.document.getElementById(found.htmlFor) as unknown as T;
}

/** Sets a value the way a user would, so React's onChange sees it. */
async function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    element.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event,
    );
  });
  await flush();
}

const cards = (container: HTMLElement) => Array.from(container.querySelectorAll('article'));
const status = (container: HTMLElement) =>
  container.querySelector('p[role="status"]')?.textContent ?? '';
const lastList = (service: ReturnType<typeof fakeService>) => service.lists().at(-1)!.query;
const form = (container: HTMLElement) => container.querySelector('form') as HTMLFormElement;

describe('supplier page: listing', () => {
  it('loads the first page sorted by name and renders a card per supplier', async () => {
    const service = fakeService(3);
    const container = await renderPage(service);

    expect(service.lists()).toHaveLength(1);
    const [list] = service.lists();
    expect(Object.fromEntries(list!.query)).toEqual({
      page: '1',
      pageSize: '20',
      sort: 'name',
      order: 'asc',
    });
    expect(list!.authorization).toBe('Bearer test-token');
    expect(cards(container).map((c) => c.querySelector('h2')?.textContent)).toEqual([
      'Supplier 01',
      'Supplier 02',
      'Supplier 03',
    ]);
    expect(status(container)).toBe('3 suppliers found');
  });

  it.each([
    ['Type', 'CAFE', 'type'],
    ['Building', BUILDINGS[0], 'building'],
    ['Sort by', 'updatedAt', 'sort'],
    ['Sort order', 'desc', 'order'],
  ] as const)('changing %s on page 2 goes back to page 1', async (label, value, param) => {
    const service = fakeService(45);
    const container = await renderPage(service);
    await click(button(container, 'Next'));
    expect(lastList(service).get('page')).toBe('2');

    const before = service.lists().length;
    await setValue(control<HTMLSelectElement>(container, label), value);
    await flush();

    expect(service.lists()).toHaveLength(before + 1);
    expect(lastList(service).get(param)).toBe(value);
    expect(lastList(service).get('page')).toBe('1');
  });

  it('debounces the search box: one request 300 ms after typing stops, on page 1', async () => {
    const service = fakeService(45);
    const clock = fakeClock();
    try {
      const container = await renderPage(service);
      await click(button(container, 'Next'));
      const before = service.lists().length;
      const search = control<HTMLInputElement>(container, 'Search suppliers');

      // Keystrokes 100 ms apart: each restarts the wait, so only the last one's timer may fire.
      for (const text of ['c', 'ca', 'caf']) {
        await clock.advance(100);
        await setValue(search, text);
      }
      await flush();
      expect(service.lists()).toHaveLength(before);

      await clock.advance(299);
      await flush();
      expect(service.lists()).toHaveLength(before);

      await clock.advance(1);
      await flush();
      expect(service.lists()).toHaveLength(before + 1);
      expect(lastList(service).get('q')).toBe('caf');
      expect(lastList(service).get('page')).toBe('1');
    } finally {
      clock.restore();
    }
  });

  it('pages with Next and Previous, disabling each at its end', async () => {
    const service = fakeService(45);
    const container = await renderPage(service);
    const next = () => button(container, 'Next');
    const previous = () => button(container, 'Previous');

    expect(previous().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    expect(container.textContent).toContain('Page 1 of 3');

    await click(next());
    expect(lastList(service).get('page')).toBe('2');
    expect(container.textContent).toContain('Page 2 of 3');
    expect(previous().disabled).toBe(false);
    expect(next().disabled).toBe(false);

    await click(next());
    expect(lastList(service).get('page')).toBe('3');
    expect(cards(container)).toHaveLength(5);
    expect(next().disabled).toBe(true);

    await click(previous());
    expect(lastList(service).get('page')).toBe('2');
    expect(cards(container)).toHaveLength(20);
  });

  it('shows an error state when the listing fails, and Try again reloads it', async () => {
    const service = fakeService(2);
    let failures = 1;
    service.override = (call) =>
      call.path === '/suppliers' && failures-- > 0
        ? failure(503, 'UNAVAILABLE', 'The supplier service is unavailable.')
        : undefined;
    const container = await renderPage(service);

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Could not load suppliers');
    expect(alert?.textContent).toContain('The supplier service is unavailable.');
    expect(cards(container)).toHaveLength(0);

    await click(button(alert!, 'Try again'));
    expect(service.lists()).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(cards(container)).toHaveLength(2);
  });

  it('keeps the page up when one supplier’s details fail, leaving out only that card', async () => {
    const service = fakeService(3);
    const broken = service.suppliers[1]!;
    service.override = (call) =>
      call.method === 'GET' && call.path === `/suppliers/${broken.supplierId}`
        ? failure(500, 'INTERNAL', 'Boom.')
        : undefined;
    const container = await renderPage(service);

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(cards(container).map((c) => c.querySelector('h2')?.textContent)).toEqual([
      'Supplier 01',
      'Supplier 03',
    ]);
    expect(status(container)).toBe("3 suppliers found (1 couldn't be loaded)");
  });

  it('shows the empty state when nothing matches', async () => {
    const container = await renderPage(fakeService(0));
    expect(status(container)).toBe('0 suppliers found');
    expect(container.textContent).toContain('No suppliers found');
    expect(container.textContent).toContain('Try another search, type or building.');
    expect(cards(container)).toHaveLength(0);
  });
});

describe('supplier page: roles', () => {
  it('gives a student no management controls', async () => {
    auth.user = { roles: ['STUDENT'] };
    const container = await renderPage(fakeService(2));
    expect(cards(container)).toHaveLength(2);
    expect(buttons(container, 'Add supplier')).toHaveLength(0);
    expect(buttons(container, 'Edit')).toHaveLength(0);
    expect(buttons(container, 'Delete')).toHaveLength(0);
  });

  it('gives an admin Add, and Edit and Delete on every card', async () => {
    const container = await renderPage(fakeService(2));
    expect(buttons(container, 'Add supplier')).toHaveLength(1);
    expect(buttons(container, 'Edit')).toHaveLength(2);
    expect(buttons(container, 'Delete')).toHaveLength(2);
  });
});

describe('supplier page: admin writes', () => {
  it('saves an edit with PUT, If-Match set to the version and the form’s values', async () => {
    const service = fakeService(2);
    const target = service.suppliers[0]!;
    const container = await renderPage(service);

    await click(buttons(container, 'Edit')[0]!);
    await setValue(control<HTMLInputElement>(form(container), 'Name'), 'Renamed Café');
    await submit(form(container));

    const puts = service.writes('PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe(`/suppliers/${target.supplierId}`);
    expect(puts[0]!.ifMatch).toBe('1');
    expect(puts[0]!.body).toEqual({
      name: 'Renamed Café',
      type: target.type,
      building: target.building,
      floor: target.floor,
      locationDescription: target.locationDescription,
      imageUrl: null,
      latitude: null,
      longitude: null,
      tags: null,
      openingHours: target.openingHours,
    });
    expect(form(container)).toBeNull();
    expect(service.lists()).toHaveLength(2);
    expect(cards(container)[0]!.querySelector('h2')?.textContent).toBe('Renamed Café');
  });

  it('deletes after confirming, with If-Match, then reloads the list', async () => {
    const service = fakeService(2);
    const target = service.suppliers[0]!;
    const confirm = window.confirm;
    const asked: string[] = [];
    window.confirm = (message?: string) => {
      asked.push(message ?? '');
      return true;
    };
    try {
      const container = await renderPage(service);
      await click(buttons(container, 'Delete')[0]!);

      expect(asked).toEqual([`Delete ${target.name}? It will disappear from the supplier list.`]);
      const deletes = service.writes('DELETE');
      expect(deletes.map((c) => [c.path, c.ifMatch])).toEqual([
        [`/suppliers/${target.supplierId}`, '1'],
      ]);
      expect(service.lists()).toHaveLength(2);
      expect(status(container)).toBe('1 supplier found');
      expect(cards(container).map((c) => c.querySelector('h2')?.textContent)).toEqual([
        'Supplier 02',
      ]);
    } finally {
      window.confirm = confirm;
    }
  });

  it('keeps typed values after a 412 and retries with the refreshed version', async () => {
    const service = fakeService(1);
    const container = await renderPage(service);
    // Another admin saves after this page loaded version 1.
    service.suppliers[0] = { ...service.suppliers[0]!, floor: '2', version: 2 };

    await click(button(container, 'Edit'));
    await setValue(control<HTMLInputElement>(form(container), 'Name'), 'Mine');
    await submit(form(container));

    expect(form(container)).not.toBeNull();
    expect(control<HTMLInputElement>(form(container), 'Name').value).toBe('Mine');
    expect(form(container).textContent).toContain('This supplier was changed by someone else.');

    await submit(form(container));
    const puts = service.writes('PUT');
    expect(puts.map((c) => c.ifMatch)).toEqual(['1', '2']);
    expect(puts.map((c) => (c.body as { name: string }).name)).toEqual(['Mine', 'Mine']);
    expect(form(container)).toBeNull();
  });

  it('marks each field the service rejects with a 422', async () => {
    const service = fakeService(1);
    service.override = (call) =>
      call.method === 'PUT'
        ? failure(422, 'VALIDATION_FAILED', 'Check the highlighted fields.', [
            { field: 'name', code: 'TOO_LONG', message: 'Name is too long.' },
            { field: 'floor', code: 'REQUIRED', message: 'Enter a floor.' },
          ])
        : undefined;
    const container = await renderPage(service);

    await click(button(container, 'Edit'));
    await submit(form(container));

    const name = control<HTMLInputElement>(form(container), 'Name');
    const floor = control<HTMLInputElement>(form(container), 'Floor');
    const building = control<HTMLInputElement>(form(container), 'Building');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(floor.getAttribute('aria-invalid')).toBe('true');
    expect(building.getAttribute('aria-invalid')).toBeNull();
    const describedBy = (input: HTMLElement) =>
      input
        .getAttribute('aria-describedby')!
        .split(' ')
        .map((id) => window.document.getElementById(id)?.textContent);
    expect(describedBy(name)).toContain('Name is too long.');
    expect(describedBy(floor)).toContain('Enter a floor.');
    expect(form(container).textContent).toContain('Check the highlighted fields.');
  });

  it('adds a supplier with POST and an Idempotency-Key, then reloads the list', async () => {
    const service = fakeService(1);
    const container = await renderPage(service);

    await click(button(container, 'Add supplier'));
    await setValue(control<HTMLInputElement>(form(container), 'Name'), 'New Stall');
    await submit(form(container));

    const posts = service.writes('POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe('/suppliers');
    expect(posts[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect((posts[0]!.body as { name: string }).name).toBe('New Stall');
    expect(form(container)).toBeNull();
    expect(service.lists()).toHaveLength(2);
  });

  it('sends the same key when the same values are saved again after a failed answer', async () => {
    const service = fakeService(1);
    let fail = true;
    service.override = (call) => {
      if (call.method !== 'POST' || !fail) return undefined;
      fail = false;
      return failure(503, 'UNAVAILABLE', 'Try again shortly.');
    };
    const container = await renderPage(service);

    await click(button(container, 'Add supplier'));
    await setValue(control<HTMLInputElement>(form(container), 'Name'), 'New Stall');
    await submit(form(container));
    expect(form(container)).not.toBeNull();
    await submit(form(container));

    const keys = service.writes('POST').map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]!);
    expect(form(container)).toBeNull();
  });

  it('uses a new key once the values change, and for the next supplier', async () => {
    const service = fakeService(1);
    let reject = true;
    service.override = (call) => {
      if (call.method !== 'POST' || !reject) return undefined;
      reject = false;
      return failure(422, 'VALIDATION_FAILED', 'Check the highlighted fields.', [
        { field: 'name', code: 'TOO_LONG', message: 'Name is too long.' },
      ]);
    };
    const container = await renderPage(service);

    await click(button(container, 'Add supplier'));
    await setValue(control<HTMLInputElement>(form(container), 'Name'), 'A very long name');
    await submit(form(container));
    await setValue(control<HTMLInputElement>(form(container), 'Name'), 'Short');
    await submit(form(container));
    expect(form(container)).toBeNull();

    await click(button(container, 'Add supplier'));
    await setValue(control<HTMLInputElement>(form(container), 'Name'), 'Another');
    await submit(form(container));

    const keys = service.writes('POST').map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    expect(service.writes('POST').every((c) => c.idempotencyKey)).toBe(true);
  });

  it('gives an admin the console navigation, with Suppliers in it once', async () => {
    await renderPage(fakeService(1));
    expect(shellNav.filter((item) => item.href === '/suppliers')).toEqual([
      { href: '/suppliers', label: 'Suppliers' },
    ]);
    expect(shellNav.some((item) => item.href === '/admin')).toBe(true);
  });
});

/**
 * A manual clock for the page's long timers (the 300 ms search debounce). Short timers, which React
 * and `settle` rely on, keep running for real. Bun's own fake timers lack `advanceTimersByTime` in
 * the version this repo pins.
 */
function fakeClock() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const pending = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  let nextId = 1;
  globalThis.setTimeout = ((run: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => {
    if (ms < 100) return real.setTimeout(run, ms, ...args);
    const id = nextId++;
    pending.set(id, { at: now + ms, run: () => run(...args) });
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    if (typeof id === 'number' && pending.delete(id)) return;
    real.clearTimeout(id as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  return {
    async advance(ms: number) {
      now += ms;
      const due = [...pending].filter(([, t]) => t.at <= now).sort(([, a], [, b]) => a.at - b.at);
      for (const [id, timer] of due) {
        pending.delete(id);
        await act(async () => timer.run());
      }
    },
    restore() {
      Object.assign(globalThis, real);
    },
  };
}
