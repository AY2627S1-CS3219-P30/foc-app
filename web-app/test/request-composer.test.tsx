import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { Window } from 'happy-dom';
import type { Draft } from '../src/lib/composer';
import type { Order } from '../src/lib/order-api';

const window = new Window();
Object.assign(globalThis, {
  window,
  document: window.document,
  sessionStorage: window.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const auth = { authed: <T,>(call: (token: string) => Promise<T>) => call('test-token') };
const router = { push: mock((href: string) => void href), replace: mock((href: string) => void href) };
let search = new URLSearchParams();
mock.module('../src/lib/auth', () => ({ useAuth: () => auth }));
mock.module('../src/components/ResponsiveShell', () => ({
  ResponsiveShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
mock.module('next/navigation', () => ({ useRouter: () => router, useSearchParams: () => search }));
const { default: ReviewPage } = await import('../src/app/(app)/request/new/review/page');
const { OrderDetail } = await import('../src/app/(app)/request/[id]/OrderDetail');
const { SUPPLIER_UNAVAILABLE } = await import('../src/components/SupplierPicker');

afterAll(() => {
  for (const key of ['window', 'document', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'])
    delete (globalThis as Record<string, unknown>)[key];
});

const SUPPLIER_ID = '00000000-0000-4000-8000-000000000001';
const ORDER_ID = '11111111-0000-4000-8000-000000000001';
const DRAFT: Draft = {
  supplierId: SUPPLIER_ID,
  items: [{ name: 'Kopi O', quantity: 2, note: 'less sugar' }],
  deliveryZone: 'PGP House 7',
  deliveryInstructions: 'Lobby counter',
  reward: 3,
  idempotencyKey: 'draft-key',
};
const supplier = {
  supplierId: SUPPLIER_ID,
  name: 'Kopi Corner',
  type: 'CAFE',
  building: 'COM2',
  floor: '1',
  locationDescription: 'By the stairs',
  openingHours: null,
  latitude: null,
  longitude: null,
  imageUrl: null,
  tags: null,
  active: true,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const order = (changes: Partial<Order> = {}): Order => ({
  orderId: ORDER_ID,
  supplier: {
    supplierId: SUPPLIER_ID,
    name: 'Kopi Corner',
    type: 'CAFE',
    building: 'COM2',
    floor: '1',
    locationDescription: 'By the stairs',
  },
  items: [{ name: 'Kopi O', quantity: 2, note: 'less sugar' }],
  deliveryZone: 'PGP House 7',
  deliveryInstructions: 'Lobby counter',
  reward: 3,
  status: 'PENDING_CREDIT',
  version: 1,
  acceptanceDeadlineAt: null,
  createdAt: '2026-10-20T01:00:00.000Z',
  updatedAt: '2026-10-20T01:00:00.000Z',
  ...changes,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, correlationId: 'test' } });

type Post = { key: string | null; body: unknown };

/** The Supplier, Credit and Order services behind `fetch`. `answer` decides each `POST /orders`. */
function fakeServices({ available = 10 } = {}) {
  const services = {
    posts: [] as Post[],
    answer: (): Promise<Response> | Response => json(201, order()),
    reads: [] as Order[],
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === `/suppliers/${SUPPLIER_ID}`) return json(200, supplier);
      if (pathname === '/wallets/me')
        return json(200, { userId: 'me', available, reserved: 0, total: available, createdAt: '', updatedAt: '' });
      if (pathname === '/orders' && request.method === 'POST') {
        services.posts.push({ key: request.headers.get('idempotency-key'), body: await request.json() });
        return services.answer();
      }
      if (pathname === `/orders/${ORDER_ID}`) return json(200, services.reads.shift() ?? order());
      return failure(404, 'NOT_FOUND', 'Not found.');
    },
  };
  return services;
}

const realFetch = globalThis.fetch;
const realTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  sessionStorage.clear();
  router.push.mockClear();
  router.replace.mockClear();
  search = new URLSearchParams({ supplierId: SUPPLIER_ID });
});

afterEach(async () => {
  if (mounted) await act(() => mounted!.unmount());
  mounted = null;
  globalThis.fetch = realFetch;
  Object.assign(globalThis, realTimers);
  setSystemTime();
});

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(() => new Promise((resolve) => realTimers.setTimeout(resolve, 0)));
};

async function render(element: React.ReactElement, services: ReturnType<typeof fakeServices>) {
  globalThis.fetch = ((request: Request) => services.fetch(request)) as typeof fetch;
  const container = window.document.createElement('div');
  window.document.body.replaceChildren(container);
  const root = createRoot(container as unknown as Element);
  mounted = root;
  await act(() => root.render(element));
  await flush();
  return container as unknown as HTMLElement;
}

const button = (scope: ParentNode, text: string) => {
  const found = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!found) throw new Error(`No "${text}" button`);
  return found;
};
const savedDraft = () => JSON.parse(sessionStorage.getItem('foc.request-draft') ?? 'null');

describe('review and submit', () => {
  beforeEach(() => sessionStorage.setItem('foc.request-draft', JSON.stringify(DRAFT)));

  it('shows the supplier, items, zone, open period, reward and both balances', async () => {
    const container = await render(<ReviewPage />, fakeServices({ available: 10 }));
    const text = container.textContent!;
    expect(text).toContain('Kopi Corner — COM2, floor 1');
    expect(text).toContain('2 × Kopi O (less sugar)');
    expect(text).toContain('PGP House 7');
    expect(text).toContain('Open for 60 minutes once your credits are reserved');
    expect(text).toContain('Reward3 credits');
    expect(text).toContain('Available balance10 credits');
    expect(text).toContain('Available after reserving the reward7 credits');
  });

  it('sends one POST with one key on a double click, then opens the order', async () => {
    const services = fakeServices();
    let respond!: () => void;
    services.answer = () => new Promise((resolve) => (respond = () => resolve(json(201, order()))));
    const container = await render(<ReviewPage />, services);

    const post = button(container, 'Post request');
    await act(async () => {
      post.click();
      post.click();
    });
    await flush();
    expect(post.disabled).toBe(true);
    expect(services.posts).toEqual([{ key: 'draft-key', body: expect.objectContaining({ reward: 3 }) }]);

    respond();
    await flush();
    expect(router.replace).toHaveBeenCalledWith(`/request/${ORDER_ID}`);
    expect(savedDraft()).toBeNull();
  });

  it('retries a failed send with the same key and keeps the draft until it lands', async () => {
    const services = fakeServices();
    const answers = [failure(503, 'SUPPLIER_SERVICE_UNAVAILABLE', 'down'), json(200, order())];
    services.answer = () => answers.shift()!;
    const container = await render(<ReviewPage />, services);

    await act(async () => button(container, 'Post request').click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Try again');
    expect(savedDraft()?.idempotencyKey).toBe('draft-key');

    await act(async () => button(container, 'Try again').click());
    await flush();
    expect(services.posts.map((p) => p.key)).toEqual(['draft-key', 'draft-key']);
    expect(router.replace).toHaveBeenCalledWith(`/request/${ORDER_ID}`);
  });

  it('blocks a student with no credits and points them to courier work', async () => {
    const container = await render(<ReviewPage />, fakeServices({ available: 0 }));
    expect(button(container, 'Post request').disabled).toBe(true);
    expect(container.textContent).toContain('Delivering errands as a courier is how you earn credits.');
    expect(container.textContent).not.toContain('Available after reserving the reward');
  });

  it('blocks a reward larger than the available balance', async () => {
    const container = await render(<ReviewPage />, fakeServices({ available: 2 }));
    expect(button(container, 'Post request').disabled).toBe(true);
    expect(container.textContent).toContain('This reward needs 3 credits and you have 2 available.');
  });

  it('explains an inactive supplier and goes back to the picker', async () => {
    const services = fakeServices();
    services.answer = () => failure(422, 'INVALID_SUPPLIER', 'The supplier is not active.');
    const container = await render(<ReviewPage />, services);

    await act(async () => button(container, 'Post request').click());
    await flush();
    expect(container.textContent).toContain(SUPPLIER_UNAVAILABLE);
    await act(async () => button(container, 'Back to pickup points').click());
    expect(router.push).toHaveBeenCalledWith('/request/new');
  });
});

describe('order status', () => {
  /** Timers from 1 s up are queued until `advance`; `Date.now` moves with them. */
  function fakeClock() {
    const pending: { at: number; run: () => void }[] = [];
    let now = Date.parse('2026-10-20T01:00:00.000Z');
    setSystemTime(new Date(now));
    globalThis.setTimeout = ((run: () => void, ms = 0) => {
      if (ms < 1000) return realTimers.setTimeout(run, ms);
      pending.push({ at: now + ms, run });
      return pending.length;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    return {
      async advance(ms: number) {
        now += ms;
        setSystemTime(new Date(now));
        for (const timer of pending.splice(0).filter((t) => t.at <= now)) await act(async () => timer.run());
        await flush();
      },
    };
  }

  it('shows the pending state in words, then the deadline once open', async () => {
    const clock = fakeClock();
    const services = fakeServices();
    services.reads = [order()];
    const container = await render(<OrderDetail orderId={ORDER_ID} />, services);
    expect(container.textContent).toContain('Waiting for credits');
    expect(container.textContent).toContain('The Credit Service is reserving its reward');

    services.reads = [order({ status: 'OPEN', acceptanceDeadlineAt: '2026-10-20T02:00:00.000Z' })];
    await clock.advance(1000);
    expect(container.textContent).toContain('Open until');
    expect(container.textContent).not.toContain('Waiting for credits');
  });

  it('switches to still-waiting copy when credits take a while', async () => {
    const clock = fakeClock();
    const services = fakeServices();
    services.reads = Array.from({ length: 10 }, () => order());
    const container = await render(<OrderDetail orderId={ORDER_ID} />, services);
    expect(container.textContent).not.toContain('taking longer than usual');

    for (const wait of [1000, 2000, 4000, 8000, 15000]) await clock.advance(wait);
    expect(container.textContent).toContain('This is taking longer than usual');
  });

  it('explains a rejection with the balance the Credit Service reported', async () => {
    const services = fakeServices();
    services.reads = [
      order({ status: 'REJECTED', rejection: { reason: 'INSUFFICIENT_CREDITS', available: 1 } }),
    ];
    const container = await render(<OrderDetail orderId={ORDER_ID} />, services);
    expect(container.textContent).toContain('Not placed');
    expect(container.textContent).toContain(
      'You had 1 available for a 3-credit reward. Post it again with a reward of 1 or less',
    );
  });
});
