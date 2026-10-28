import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { Window } from 'happy-dom';
import { toCreateOrder, type Draft } from '../src/lib/composer';
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

const auth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call('test-token'),
  user: { id: 'me' },
};
const router = { push: mock((href: string) => void href), replace: mock((href: string) => void href) };
let search = new URLSearchParams();
mock.module('../src/lib/auth', () => ({ useAuth: () => auth }));
mock.module('../src/components/ResponsiveShell', () => ({
  ResponsiveShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
mock.module('next/navigation', () => ({ useRouter: () => router, useSearchParams: () => search }));
const { default: DetailsPage } = await import('../src/app/(app)/request/new/details/page');
const { default: ReviewPage } = await import('../src/app/(app)/request/new/review/page');
const { OrderDetail } = await import('../src/app/(app)/request/[id]/OrderDetail');
const { SUPPLIER_UNAVAILABLE } = await import('../src/components/SupplierPicker');
const { CreditsProvider } = await import('../src/lib/credits');

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
  serverTime: '2026-10-20T01:00:00.000Z',
  requesterId: 'me',
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
    reads: [] as (Order | Response | Promise<Response>)[],
    gets: 0,
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === `/orders/${ORDER_ID}/history`) return json(200, { orderId: ORDER_ID, entries: [] });
      if (pathname === `/suppliers/${SUPPLIER_ID}`) return json(200, supplier);
      if (pathname === '/wallets/me')
        return json(200, { userId: 'me', available, reserved: 0, total: available, createdAt: '', updatedAt: '' });
      if (pathname === '/orders' && request.method === 'POST') {
        services.posts.push({ key: request.headers.get('idempotency-key'), body: await request.json() });
        return services.answer();
      }
      if (pathname === `/orders/${ORDER_ID}`) {
        services.gets++;
        const next = services.reads.shift() ?? order();
        return next instanceof Response || next instanceof Promise
          ? next
          : json(200, { ...next, serverTime: new Date().toISOString() });
      }
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
  await act(() => root.render(<CreditsProvider>{element}</CreditsProvider>));
  await flush();
  return container as unknown as HTMLElement;
}

const button = (scope: ParentNode, text: string) => {
  const found = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!found) throw new Error(`No "${text}" button`);
  return found;
};
const DRAFT_KEY = 'foc.request-draft:me';
const saveDraft = (draft: Draft) => sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
const savedDraft = () => JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null');

describe('review and submit', () => {
  beforeEach(() => saveDraft(DRAFT));

  it('shows the supplier, items, zone, open period, reward and both balances', async () => {
    const container = await render(<ReviewPage />, fakeServices({ available: 10 }));
    const text = container.textContent!;
    expect(text).toContain('Kopi Corner — COM2, floor 1');
    expect(text).toContain('2 × Kopi O (less sugar)');
    expect(text).toContain('PGP House 7');
    expect(text).toContain(
      'Open for a set time once your credits are reserved; the request shows the deadline',
    );
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
    expect(router.replace).toHaveBeenCalledWith(`/request/${ORDER_ID}?replayed=1`);
  });

  it('says the request was already posted when the first send replays it', async () => {
    const services = fakeServices();
    services.answer = () => json(200, order());
    const container = await render(<ReviewPage />, services);

    await act(async () => button(container, 'Post request').click());
    await flush();
    expect(services.posts).toHaveLength(1);
    expect(router.replace).toHaveBeenCalledWith(`/request/${ORDER_ID}?replayed=1`);
    expect(savedDraft()).toBeNull();
  });

  it('finds the errand an earlier version posted when its response was lost and the details changed', async () => {
    saveDraft({ ...DRAFT, reward: 4, sentBody: toCreateOrder(DRAFT) });
    const services = fakeServices();
    const answers = [
      failure(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used.'),
      json(200, order()),
    ];
    services.answer = () => answers.shift()!;
    const container = await render(<ReviewPage />, services);

    await act(async () => button(container, 'Post request').click());
    await flush();
    expect(services.posts).toEqual([
      { key: 'draft-key', body: expect.objectContaining({ reward: 4 }) },
      { key: 'draft-key', body: expect.objectContaining({ reward: 3 }) },
    ]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("weren't applied");

    await act(async () => button(container, 'View request').click());
    expect(router.replace).toHaveBeenCalledWith(`/request/${ORDER_ID}`);
  });

  it('keeps the edits the earlier errand missed under a new key, to post on request', async () => {
    saveDraft({ ...DRAFT, reward: 4, sentBody: toCreateOrder(DRAFT) });
    const services = fakeServices();
    const answers = [
      failure(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used.'),
      json(200, order()),
      json(201, order({ orderId: 'new-order', reward: 4 })),
    ];
    services.answer = () => answers.shift()!;
    const container = await render(<ReviewPage />, services);

    await act(async () => button(container, 'Post request').click());
    await flush();
    const kept = savedDraft();
    expect(kept).toMatchObject({ reward: 4, deliveryZone: 'PGP House 7' });
    expect(kept.idempotencyKey).not.toBe('draft-key');
    expect(kept.sentBody).toBeUndefined();

    await act(async () => button(container, 'Post these changes as a new request').click());
    await flush();
    await act(async () => button(container, 'Post request').click());
    await flush();
    expect(services.posts[2]).toEqual({
      key: kept.idempotencyKey,
      body: expect.objectContaining({ reward: 4 }),
    });
    expect(router.replace).toHaveBeenCalledWith('/request/new-order');
    expect(savedDraft()).toBeNull();
  });

  it('starts over under a new key when another tab already sent this key', async () => {
    const services = fakeServices();
    services.answer = () =>
      failure(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used.');
    const container = await render(<ReviewPage />, services);

    await act(async () => button(container, 'Post request').click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('another tab');
    expect(savedDraft()?.sentBody).toBeUndefined();

    await act(async () => button(container, 'Start over').click());
    const restarted = savedDraft();
    expect(restarted).toMatchObject({ reward: 3, deliveryZone: 'PGP House 7' });
    expect(restarted.idempotencyKey).not.toBe('draft-key');

    services.answer = () => json(201, order());
    await act(async () => button(container, 'Post request').click());
    await flush();
    expect(services.posts.at(-1)?.key).toBe(restarted.idempotencyKey);
    expect(router.replace).toHaveBeenCalledWith(`/request/${ORDER_ID}`);
  });

  it('remembers the body it sent, so a later edit can still find that errand', async () => {
    const services = fakeServices();
    services.answer = () => failure(503, 'SUPPLIER_SERVICE_UNAVAILABLE', 'down');
    const container = await render(<ReviewPage />, services);

    await act(async () => button(container, 'Post request').click());
    await flush();
    expect(savedDraft()?.sentBody).toEqual(services.posts[0]!.body);
  });

  it('keeps a body whose response was lost when a later edit is refused', async () => {
    saveDraft({ ...DRAFT, reward: 4, sentBody: toCreateOrder(DRAFT) });
    const services = fakeServices();
    services.answer = () => failure(403, 'ACCOUNT_SUSPENDED', 'Suspended.');
    const container = await render(<ReviewPage />, services);

    await act(async () => button(container, 'Post request').click());
    await flush();
    expect(savedDraft()?.sentBody).toEqual(toCreateOrder(DRAFT));
  });

  it('lets a sent body post again despite a shortfall, as it may hold the reward', async () => {
    saveDraft({ ...DRAFT, sentBody: toCreateOrder(DRAFT) });
    const container = await render(<ReviewPage />, fakeServices({ available: 0 }));
    expect(container.textContent).toContain('Delivering errands as a courier is how you earn credits.');
    expect(button(container, 'Post request').disabled).toBe(false);
  });

  it('still posts when the balance cannot be read', async () => {
    const services = fakeServices();
    const { fetch } = services;
    services.fetch = async (request) =>
      new URL(request.url).pathname === '/wallets/me'
        ? failure(503, 'UNAVAILABLE', 'down')
        : fetch(request);
    const container = await render(<ReviewPage />, services);
    expect(container.textContent).toContain('Could not load your balance');

    await act(async () => button(container, 'Post request').click());
    await flush();
    expect(router.replace).toHaveBeenCalledWith(`/request/${ORDER_ID}`);
  });

  it('takes the service\'s field errors back to the details form', async () => {
    const services = fakeServices();
    services.answer = () =>
      json(422, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The order request is invalid.',
          correlationId: 'test',
          details: [{ field: 'items.0.name', code: 'too_small', message: 'Name the item.' }],
        },
      });
    const review = await render(<ReviewPage />, services);
    await act(async () => button(review, 'Post request').click());
    await flush();
    expect(review.textContent).toContain('Item 1: Name the item.');
    expect(savedDraft()?.sentBody).toBeUndefined();

    const details = await render(<DetailsPage />, services);
    const name = details.querySelector('input')!;
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(details.querySelector(`#${name.getAttribute('aria-describedby')}`)?.textContent).toBe(
      'Name the item.',
    );
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

describe('details', () => {
  it('marks the invalid fields and focuses the first one when review fails', async () => {
    const container = await render(<DetailsPage />, fakeServices());
    await act(async () => button(container, 'Review request').click());
    const name = container.querySelector('input')!;
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(window.document.activeElement).toBe(name as unknown as Element);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('focuses the items, described by their error, when that is the only error', async () => {
    saveDraft({ ...DRAFT, items: [] });
    const container = await render(<DetailsPage />, fakeServices());
    await act(async () => button(container, 'Review request').click());
    const items = container.querySelector('fieldset')!;
    expect(window.document.activeElement?.tagName).toBe('FIELDSET');
    expect(container.querySelector(`#${items.getAttribute('aria-describedby')}`)?.textContent).toBe(
      'Add at least one item.',
    );
  });

  it('keeps each error on its own item when an earlier item is removed', async () => {
    saveDraft({
      ...DRAFT,
      items: [DRAFT.items[0], { name: 'Kaya toast', quantity: 1, note: '' }],
      errors: { 'items.1.name': 'Name the item.' },
    });
    const container = await render(<DetailsPage />, fakeServices());
    await act(async () => button(container, 'Remove item 1').click());
    const name = container.querySelector('input')!;
    expect(name.value).toBe('Kaya toast');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Name the item.');
  });
});

describe('order status', () => {
  /** Timers from 1 s up are queued until `advance`; `Date.now` moves with them. */
  function fakeClock() {
    const pending = new Map<number, { at: number; run: () => void }>();
    let now = Date.parse('2026-10-20T01:00:00.000Z');
    let id = 0;
    setSystemTime(new Date(now));
    globalThis.setTimeout = ((run: () => void, ms = 0) => {
      if (ms < 1000) return realTimers.setTimeout(run, ms);
      pending.set(++id, { at: now + ms, run });
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: number) => {
      if (!pending.delete(timer)) realTimers.clearTimeout(timer);
    }) as typeof clearTimeout;
    return {
      async advance(ms: number) {
        now += ms;
        setSystemTime(new Date(now));
        for (const [key, timer] of pending)
          if (timer.at <= now) {
            pending.delete(key);
            await act(async () => timer.run());
          }
        await flush();
      },
    };
  }

  const setVisibility = async (state: 'visible' | 'hidden') => {
    Object.defineProperty(window.document, 'visibilityState', { value: state, configurable: true });
    await act(async () => window.document.dispatchEvent(new window.Event('visibilitychange')));
    await flush();
  };
  afterEach(() => {
    delete (window.document as { visibilityState?: string }).visibilityState;
    window.happyDOM.setURL('about:blank');
  });

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

  for (const [status, copy] of [
    ['COMPLETION_PENDING_CREDIT', 'the courier is paid as soon as the transfer goes through'],
    ['RELEASE_PENDING_CREDIT', 'Your credits are safe'],
  ] as const) {
    it(`switches to still-waiting copy when ${status} takes a while`, async () => {
      const clock = fakeClock();
      const services = fakeServices();
      services.reads = Array.from({ length: 10 }, () => order({ status }));
      const container = await render(<OrderDetail orderId={ORDER_ID} />, services);
      expect(container.textContent).not.toContain('taking longer than usual');

      for (const wait of [1000, 2000, 4000, 8000, 15000]) await clock.advance(wait);
      expect(container.textContent).toContain('This is taking longer than usual');
      expect(container.textContent).toContain(copy);
    });
  }

  it('never calls a settled errand slow', async () => {
    const clock = fakeClock();
    const services = fakeServices();
    services.reads = Array.from({ length: 3 }, () => order({ status: 'ACCEPTED' }));
    const container = await render(<OrderDetail orderId={ORDER_ID} />, services);
    await clock.advance(30_000);
    await clock.advance(30_000);
    expect(services.gets).toBe(3);
    expect(container.textContent).not.toContain('taking longer than usual');
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

  it('keeps reading an open errand every 30 seconds until it reaches a final state', async () => {
    const clock = fakeClock();
    const services = fakeServices();
    services.reads = [order({ status: 'OPEN', acceptanceDeadlineAt: '2026-10-20T02:00:00.000Z' })];
    const container = await render(<OrderDetail orderId={ORDER_ID} />, services);
    expect(container.textContent).toContain('Open until');

    services.reads = [order({ status: 'EXPIRED' })];
    await clock.advance(29_000);
    expect(services.gets).toBe(1);
    await clock.advance(1_000);
    expect(container.textContent).toContain('Expired');

    await clock.advance(60_000);
    await act(async () => window.dispatchEvent(new window.Event('online')));
    await setVisibility('visible');
    expect(services.gets).toBe(2);
  });

  it('pauses while the tab is hidden and reads as soon as it is shown again', async () => {
    const clock = fakeClock();
    const services = fakeServices();
    services.reads = [order({ status: 'OPEN', acceptanceDeadlineAt: '2026-10-20T02:00:00.000Z' })];
    const container = await render(<OrderDetail orderId={ORDER_ID} />, services);

    await setVisibility('hidden');
    await clock.advance(60_000);
    expect(services.gets).toBe(1);

    services.reads = [order({ status: 'ACCEPTED' })];
    await setVisibility('visible');
    expect(services.gets).toBe(2);
    expect(container.textContent).toContain('A courier has accepted the errand');
    expect(container.textContent).not.toContain('Post a new request');
  });

  it('reads again at once when the connection returns while a read is failing', async () => {
    const clock = fakeClock();
    const services = fakeServices();
    const open = order({ status: 'OPEN', acceptanceDeadlineAt: '2026-10-20T02:00:00.000Z' });
    services.reads = [open];
    const container = await render(<OrderDetail orderId={ORDER_ID} />, services);

    let fail!: (err: Error) => void;
    services.reads = [new Promise<Response>((_, reject) => (fail = reject)), order({ status: 'ACCEPTED' })];
    const online = async () => {
      await act(async () => window.dispatchEvent(new window.Event('online')));
      await flush();
    };
    await online();
    expect(services.gets).toBe(2);
    await online();
    expect(services.gets).toBe(3);
    expect(container.textContent).toContain('A courier has accepted the errand');

    await act(async () => fail(new TypeError('fetch failed')));
    await flush();
    expect(container.textContent).not.toContain('Could not');
    await clock.advance(30_000);
    expect(services.gets).toBe(4);
  });

  it('stops reading a settled errand after ten minutes without a change, until the tab is shown', async () => {
    const clock = fakeClock();
    const services = fakeServices();
    services.reads = Array.from({ length: 30 }, () =>
      order({ status: 'OPEN', acceptanceDeadlineAt: '2026-10-20T02:00:00.000Z' }),
    );
    await render(<OrderDetail orderId={ORDER_ID} />, services);

    for (let i = 0; i < 20; i++) await clock.advance(30_000);
    expect(services.gets).toBe(21);
    await clock.advance(60_000);
    expect(services.gets).toBe(21);

    await setVisibility('hidden');
    await setVisibility('visible');
    expect(services.gets).toBe(22);
    await clock.advance(30_000);
    expect(services.gets).toBe(23);
  });

  it('reads again on reconnecting, even after an error stopped polling', async () => {
    const clock = fakeClock();
    const services = fakeServices();
    services.reads = [failure(429, 'RATE_LIMITED', 'Too many requests.')];
    const container = await render(<OrderDetail orderId={ORDER_ID} />, services);
    expect(container.textContent).toContain('Could not load this request');
    await clock.advance(60_000);
    expect(services.gets).toBe(1);

    services.reads = [order({ status: 'OPEN', acceptanceDeadlineAt: '2026-10-20T02:00:00.000Z' })];
    await act(async () => window.dispatchEvent(new window.Event('online')));
    await flush();
    expect(services.gets).toBe(2);
    expect(container.textContent).toContain('Open until');
    expect(container.textContent).not.toContain('Could not');
  });

  it('offers an expired errand as a new request under a new key', async () => {
    const services = fakeServices();
    services.reads = [order({ status: 'EXPIRED' })];
    const container = await render(<OrderDetail orderId={ORDER_ID} />, services);

    await act(async () => button(container, 'Post a new request').click());
    const draft = savedDraft();
    expect(draft).toMatchObject({ supplierId: SUPPLIER_ID, deliveryZone: 'PGP House 7', reward: 3 });
    expect(draft.idempotencyKey).toBeString();
    expect(draft.sentBody).toBeUndefined();
    expect(router.push).toHaveBeenCalledWith(`/request/new/details?supplierId=${SUPPLIER_ID}`);
  });

  it('says when the request was already posted', async () => {
    window.happyDOM.setURL(`http://localhost/request/${ORDER_ID}?replayed=1`);
    const container = await render(<OrderDetail orderId={ORDER_ID} />, fakeServices());
    expect(container.textContent).toContain('This request was already posted');
    expect(window.location.search).toBe('');
  });

  it('stops on an error that is not an API failure instead of loading forever', async () => {
    const clock = fakeClock();
    const authed = auth.authed;
    const read = mock(async (call: (token: string) => Promise<unknown>) => {
      await call('test-token');
      throw new TypeError('boom');
    });
    auth.authed = read;
    const services = fakeServices();
    const { fetch } = services;
    let orderReads = 0;
    services.fetch = async (request) => {
      if (new URL(request.url).pathname === `/orders/${ORDER_ID}`) orderReads++;
      return fetch(request);
    };
    try {
      const container = await render(<OrderDetail orderId={ORDER_ID} />, services);
      expect(container.textContent).toContain('Could not load this request');
      expect(container.textContent).toContain('Something went wrong.');
      await clock.advance(15000);
      expect(orderReads).toBe(1);
    } finally {
      auth.authed = authed;
    }
  });
});
