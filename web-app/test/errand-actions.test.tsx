import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { Window } from 'happy-dom';
import type { OpenOrder, Order } from '../src/lib/order-api';

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const auth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call('test-token'),
  user: { id: 'me' },
};
const router = { push: mock((href: string) => void href), back: mock(() => {}) };
mock.module('../src/lib/auth', () => ({ useAuth: () => auth }));
mock.module('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));
mock.module('../src/components/DesktopShell', () => ({
  DesktopShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const { default: FeedPage } = await import('../src/app/(app)/feed/page');
const { OrderDetail } = await import('../src/app/(app)/request/[id]/OrderDetail');
const { StoreProvider } = await import('../src/lib/store');

afterAll(() => {
  for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'])
    delete (globalThis as Record<string, unknown>)[key];
});

// Now, not a fixed date: tests without the fake clock compare deadlines with the real one.
const START = Date.now();
const ORDER_ID = '11111111-0000-4000-8000-000000000001';
const OTHER_ID = '11111111-0000-4000-8000-000000000002';
const supplier = (name: string) => ({
  supplierId: '00000000-0000-4000-8000-000000000001',
  name,
  type: 'CAFE',
  building: 'COM2',
  floor: '1',
  locationDescription: 'By the stairs',
});

const order = (changes: Partial<Order> = {}): Order => ({
  orderId: ORDER_ID,
  supplier: supplier('Kopi Corner'),
  items: [{ name: 'Kopi O', quantity: 2 }],
  deliveryZone: 'PGP House 7',
  reward: 3,
  status: 'OPEN',
  version: 3,
  acceptanceDeadlineAt: new Date(START + 3_600_000).toISOString(),
  createdAt: new Date(START).toISOString(),
  updatedAt: new Date(START).toISOString(),
  serverTime: new Date(START).toISOString(),
  requesterId: 'me',
  deliveryInstructions: 'Lobby counter',
  ...changes,
});

const listing = (orderId: string, name: string, timeRemainingSeconds = 1800): OpenOrder => ({
  orderId,
  supplier: supplier(name),
  itemSummary: [{ name: 'Kopi O', quantity: 2 }],
  deliveryZone: 'PGP House 7',
  reward: 3,
  status: 'OPEN',
  version: 1,
  acceptanceDeadlineAt: new Date(START + timeRemainingSeconds * 1000).toISOString(),
  timeRemainingSeconds,
  createdAt: new Date(START).toISOString(),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string) =>
  json(status, { error: { code, message: `${code} from the server.`, correlationId: 'test' } });

type Command = { path: string; body: unknown };

/** `serverAhead` is how far the server's clock runs ahead of this device's. */
function fakeOrderService() {
  const service = {
    open: [] as OpenOrder[],
    reads: [] as Order[],
    current: order(),
    commands: [] as Command[],
    serverAhead: 0,
    stamp: (o: Order): Order => ({ ...o, serverTime: new Date(Date.now() + service.serverAhead).toISOString() }),
    answer: (): Response => json(200, service.stamp({ ...service.current, version: 4 })),
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method === 'POST') {
        const command = { path: pathname, body: await request.json() };
        service.commands.push(command);
        return service.answer();
      }
      if (pathname === '/orders')
        return json(
          200,
          service.open
            .map((o) => ({ ...o, timeRemainingSeconds: (Date.parse(o.acceptanceDeadlineAt) - Date.now()) / 1000 }))
            .filter((o) => o.timeRemainingSeconds > 0),
        );
      if (pathname === '/wallets/me') return json(200, { available: 5 });
      if (pathname.startsWith('/orders/')) return json(200, service.stamp(service.reads.shift() ?? service.current));
      return failure(404, 'NOT_FOUND');
    },
  };
  return service;
}

/** Timers of a second or more wait for `advance`, which keeps the ones still in the future. */
function fakeClock() {
  let now = START;
  let next = 1;
  let timers: { id: number; at: number; run: () => void; every?: number }[] = [];
  setSystemTime(new Date(now));
  const schedule = (run: () => void, ms: number, every?: number) => {
    timers.push({ id: next, at: now + ms, run, every });
    return next++;
  };
  const cancel = (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  };
  Object.assign(globalThis, {
    setTimeout: (run: () => void, ms = 0) => (ms < 1000 ? realTimers.setTimeout(run, ms) : schedule(run, ms)),
    clearTimeout: (id: number) => (typeof id === 'number' && id < 1e6 ? cancel(id) : realTimers.clearTimeout(id)),
    setInterval: (run: () => void, ms: number) => schedule(run, ms, ms),
    clearInterval: cancel,
  });
  return {
    async advance(ms: number) {
      now += ms;
      setSystemTime(new Date(now));
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) {
        if (t.every) timers.push({ ...t, at: now + t.every });
        await act(async () => t.run());
      }
      await flush();
    },
  };
}

const realFetch = globalThis.fetch;
const realTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};
let mounted: { unmount: () => void } | null = null;

beforeEach(() => router.push.mockClear());

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

async function render(element: React.ReactElement, service: ReturnType<typeof fakeOrderService>) {
  globalThis.fetch = ((request: Request) => service.fetch(request)) as typeof fetch;
  const container = window.document.createElement('div');
  window.document.body.replaceChildren(container);
  const root = createRoot(container as unknown as Element);
  mounted = root;
  await act(() => root.render(<StoreProvider>{element}</StoreProvider>));
  await flush();
  return container as unknown as HTMLElement;
}

const buttons = (scope: ParentNode, text: string) =>
  Array.from(scope.querySelectorAll('button')).filter((b) => b.textContent === text);
const button = (scope: ParentNode, text: string) => {
  const [found] = buttons(scope, text);
  if (!found) throw new Error(`No "${text}" button`);
  return found;
};
const dialog = (container: HTMLElement) => container.ownerDocument.querySelector('dialog')!;

/** Clicks an action, then the confirm button in its dialog. */
async function confirmAction(container: HTMLElement, label: string, confirmLabel: string) {
  await act(async () => button(container, label).click());
  await act(async () => button(dialog(container), confirmLabel).click());
  await flush();
}

describe('feed', () => {
  it('counts down from the time the server gave and removes the card at zero', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    service.open = [listing(OTHER_ID, 'Their cafe', 90)];
    const container = await render(<FeedPage />, service);
    expect(container.textContent).toContain('2 min left');

    await clock.advance(60_000);
    expect(container.textContent).toContain('Under a minute left');
    await clock.advance(30_000);
    expect(container.textContent).not.toContain('Their cafe');
    expect(container.textContent).toContain('No open errands right now');
  });

  it('asks before accepting, sends the version it showed, then opens the errand', async () => {
    const service = fakeOrderService();
    service.open = [listing(OTHER_ID, 'Their cafe')];
    service.answer = () => json(201, order({ orderId: OTHER_ID, status: 'ACCEPTED' }));
    const container = await render(<FeedPage />, service);

    await act(async () => button(container, 'Accept').click());
    expect(dialog(container).textContent).toContain('Accept this errand?');
    expect(service.commands).toEqual([]);

    await act(async () => button(dialog(container), 'Accept').click());
    await flush();
    expect(service.commands).toEqual([{ path: `/orders/${OTHER_ID}/accept`, body: { expectedVersion: 1 } }]);
    expect(router.push).toHaveBeenCalledWith(`/request/${OTHER_ID}`);
  });

  it('replaces the card after losing the race instead of leaving a dead button', async () => {
    const service = fakeOrderService();
    service.open = [listing(OTHER_ID, 'Their cafe')];
    service.answer = () => {
      service.open = [];
      return failure(409, 'ORDER_NOT_OPEN');
    };
    const container = await render(<FeedPage />, service);

    await confirmAction(container, 'Accept', 'Accept');
    expect(container.textContent).toContain('Another courier accepted this errand first');
    expect(container.textContent).not.toContain('Their cafe');
    expect(buttons(container, 'Accept')).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('courier', () => {
  const assigned = { requesterId: 'them', courierId: 'me' };

  it('records pickup after confirming, then offers delivery', async () => {
    const service = fakeOrderService();
    service.current = order({ ...assigned, status: 'ACCEPTED' });
    service.answer = () => {
      service.current = order({ ...assigned, status: 'PICKED_UP', version: 4 });
      return json(200, service.current);
    };
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
    expect(container.textContent).toContain('Lobby counter');
    expect(buttons(container, 'Withdraw').length).toBeGreaterThan(0);

    await confirmAction(container, "I've picked it up", 'Record pickup');
    expect(service.commands).toEqual([{ path: `/orders/${ORDER_ID}/pickup`, body: { expectedVersion: 3 } }]);
    expect(buttons(container, 'Mark as delivered').length).toBeGreaterThan(0);
    expect(buttons(container, "I've picked it up")).toEqual([]);
  });

  it('shows no delivery instructions before the errand is theirs', async () => {
    const service = fakeOrderService();
    service.current = order({ requesterId: undefined, deliveryInstructions: undefined });
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
    expect(container.textContent).not.toContain('Delivery instructions');
    expect(buttons(container, 'Accept errand').length).toBeGreaterThan(0);
  });
});

describe('requester', () => {
  it('cancels an open errand, and re-reads it when the version was stale', async () => {
    const service = fakeOrderService();
    service.answer = () => {
      service.current = order({ status: 'ACCEPTED', courierId: 'them', version: 4 });
      return failure(409, 'ORDER_CHANGED');
    };
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);

    await confirmAction(container, 'Cancel errand', 'Cancel errand');
    expect(container.textContent).toContain('This errand changed before your request arrived');
    expect(container.textContent).toContain('Accepted');

    service.answer = () => {
      service.current = order({ status: 'RELEASE_PENDING_CREDIT', releaseReason: 'CANCELLED', version: 5 });
      return json(200, service.current);
    };
    await confirmAction(container, 'Cancel errand', 'Cancel errand');
    expect(service.commands.map((c) => c.body)).toEqual([{ expectedVersion: 3 }, { expectedVersion: 4 }]);
    expect(container.textContent).toContain('Returning credits');
    expect(container.textContent).toContain('It was cancelled.');
  });

  it('keeps a failed send in the dialog to try again', async () => {
    const service = fakeOrderService();
    service.answer = () => failure(503, 'INTERNAL');
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);

    await confirmAction(container, 'Cancel errand', 'Cancel errand');
    expect(dialog(container).open).toBe(true);
    expect(dialog(container).textContent).toContain('INTERNAL from the server.');
  });

  it('offers to refer an undelivered errand at 2 hours after pickup, and not before', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    service.current = order({
      status: 'PICKED_UP',
      courierId: 'them',
      nonDeliveryReportAt: new Date(START + 2 * 3_600_000).toISOString(),
    });
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
    expect(buttons(container, 'Report not delivered')).toEqual([]);

    await clock.advance(2 * 3_600_000 - 1000);
    expect(buttons(container, 'Report not delivered')).toEqual([]);

    await clock.advance(1000);
    expect(buttons(container, 'Report not delivered').length).toBeGreaterThan(0);
  });

  it("measures the deadline on the server's clock when this device's is behind", async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    service.serverAhead = 10 * 60_000;
    service.current = order({
      status: 'PICKED_UP',
      courierId: 'them',
      nonDeliveryReportAt: new Date(START + service.serverAhead + 3_600_000).toISOString(),
    });
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);

    await clock.advance(3_600_000 - 1000);
    expect(buttons(container, 'Report not delivered')).toEqual([]);

    await clock.advance(1000);
    expect(buttons(container, 'Report not delivered').length).toBeGreaterThan(0);
  });

  it('explains a report sent before the server agrees the period has passed', async () => {
    const service = fakeOrderService();
    service.current = order({
      status: 'PICKED_UP',
      courierId: 'them',
      nonDeliveryReportAt: new Date(Date.now() - 1000).toISOString(),
    });
    service.answer = () => failure(409, 'DELIVERY_PERIOD_NOT_PASSED');
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);

    await confirmAction(container, 'Report not delivered', 'Report');
    expect(container.textContent).toContain("It's too early to report this errand.");
  });

  it('confirms or reports a delivered errand until it auto-confirms', async () => {
    const service = fakeOrderService();
    service.current = order({
      status: 'DELIVERED',
      courierId: 'them',
      autoConfirmAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
    expect(buttons(container, 'Confirm receipt').length).toBeGreaterThan(0);
    expect(buttons(container, "I didn't receive it").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("it's confirmed automatically");
  });

  it('shows a referred errand as held, with no action', async () => {
    const service = fakeOrderService();
    service.current = order({ status: 'DISPUTED', courierId: 'them' });
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
    expect(container.textContent).toContain('With an administrator');
    expect(container.textContent).toContain("There's nothing for you to do while they decide.");
    expect(container.querySelectorAll('button:not([aria-label="Back"])').length).toBe(0);
  });
});
