import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { Window } from 'happy-dom';
import type { OpenOrder, Order } from '../src/lib/order-api';

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const auth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call('test-token'),
  user: { id: 'me', profile: { displayName: 'Me', preferredMode: 'REQUESTER' } },
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
const { default: OrderHistoryPage } = await import('../src/app/(app)/order-history/page');
const { OrderDetail } = await import('../src/app/(app)/request/[id]/OrderDetail');
const { useOrder } = await import('../src/lib/use-order');
const { StoreProvider } = await import('../src/lib/store');
const { CreditsProvider } = await import('../src/lib/credits');
const { TopBar } = await import('../src/components/TopBar');

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
/** A send whose answer never arrives, so the app cannot tell whether it went through. */
const lostAnswer = (): Response => {
  throw new TypeError('Failed to fetch');
};

type Command = { path: string; body: unknown };

/** `serverAhead` is how far the server's clock runs ahead of this device's. */
function fakeOrderService() {
  const service = {
    open: [] as OpenOrder[],
    reads: [] as Order[],
    current: order(),
    commands: [] as Command[],
    serverAhead: 0,
    wallet: (): Response => json(200, { available: 5 }),
    walletReads: 0,
    queries: [] as string[],
    feed: (): Response =>
      json(
        200,
        service.open
          .map((o) => ({ ...o, timeRemainingSeconds: (Date.parse(o.acceptanceDeadlineAt) - Date.now()) / 1000 }))
          .filter((o) => o.timeRemainingSeconds > 0),
      ),
    history: (): Response => json(200, { items: [], truncated: false }),
    stamp: (o: Order): Order => ({ ...o, serverTime: new Date(Date.now() + service.serverAhead).toISOString() }),
    answer: (): Response => json(200, service.stamp({ ...service.current, version: 4 })),
    read: (): Response => json(200, service.stamp(service.reads.shift() ?? service.current)),
    async fetch(request: Request): Promise<Response> {
      const { pathname, search } = new URL(request.url);
      if (pathname === `/orders/${ORDER_ID}/history`) return json(200, { orderId: ORDER_ID, entries: [] });
      if (request.method === 'GET') service.queries.push(`${pathname}${search}`);
      if (request.method === 'POST') {
        const command = { path: pathname, body: await request.json() };
        service.commands.push(command);
        return service.answer();
      }
      if (pathname === '/orders') return service.feed();
      if (pathname === '/orders/mine') return service.history();
      if (pathname === '/wallets/me') {
        service.walletReads++;
        return service.wallet();
      }
      if (pathname.startsWith('/orders/')) return service.read();
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

beforeEach(() => {
  router.push.mockClear();
  auth.user.profile.preferredMode = 'REQUESTER';
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

async function render(
  element: React.ReactElement,
  service: ReturnType<typeof fakeOrderService>,
  creditsEnabled = true,
) {
  globalThis.fetch = ((request: Request) => service.fetch(request)) as typeof fetch;
  const container = window.document.createElement('div');
  window.document.body.replaceChildren(container);
  const root = createRoot(container as unknown as Element);
  mounted = root;
  await act(() =>
    root.render(
      <StoreProvider>
        <CreditsProvider enabled={creditsEnabled}>{element}</CreditsProvider>
      </StoreProvider>,
    ),
  );
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
  beforeEach(() => {
    auth.user.profile.preferredMode = 'COURIER';
  });

  it('announces a failed background refresh in the existing alert', async () => {
    const service = fakeOrderService();
    const container = await render(<FeedPage />, service);
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('');
    expect(service.queries).toContain('/orders');
    expect(service.queries.some((query) => query.startsWith('/orders/mine'))).toBe(false);

    service.feed = () => failure(503, 'INTERNAL');
    await act(async () => window.dispatchEvent(new window.Event('online')));
    await flush();
    expect(container.querySelector('[role="alert"]')).toBe(alert);
    expect(alert.textContent).toContain('Could not refresh the list.');
  });

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

    expect(button(container, 'Accept').getAttribute('aria-label')).toBe('Accept errand from Their cafe');
    await act(async () => button(container, 'Accept').click());
    expect(dialog(container).textContent).toContain('Accept this errand?');
    expect(container.ownerDocument.activeElement).toBe(button(dialog(container), 'Accept'));
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
    const focused = container.ownerDocument.activeElement;
    expect(focused?.getAttribute('role')).toBe('status');
    expect(focused?.textContent).toContain('Another courier accepted');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('opens the errand when a retry is refused because the lost first accept went through', async () => {
    const service = fakeOrderService();
    service.open = [listing(OTHER_ID, 'Their cafe')];
    service.answer = lostAnswer;
    const container = await render(<FeedPage />, service);

    await confirmAction(container, 'Accept', 'Accept');
    expect(dialog(container).open).toBe(true);
    expect(dialog(container).textContent).toContain("Can't reach the server.");

    service.current = order({ orderId: OTHER_ID, status: 'ACCEPTED', requesterId: 'them', courierId: 'me', version: 2 });
    service.answer = () => failure(409, 'ORDER_NOT_OPEN');
    await act(async () => button(dialog(container), 'Accept').click());
    await flush();
    expect(service.commands.map((c) => c.body)).toEqual([{ expectedVersion: 1 }, { expectedVersion: 1 }]);
    expect(container.textContent).not.toContain('Another courier');
    expect(router.push).toHaveBeenCalledWith(`/request/${OTHER_ID}`);
  });

  it('still reports losing the race when the retry finds another courier on the errand', async () => {
    const service = fakeOrderService();
    service.open = [listing(OTHER_ID, 'Their cafe')];
    service.answer = lostAnswer;
    const container = await render(<FeedPage />, service);
    await confirmAction(container, 'Accept', 'Accept');

    service.open = [];
    service.current = order({ orderId: OTHER_ID, status: 'ACCEPTED', requesterId: 'them', courierId: 'other' });
    service.answer = () => failure(409, 'ORDER_NOT_OPEN');
    await act(async () => button(dialog(container), 'Accept').click());
    await flush();
    expect(container.textContent).toContain('Another courier accepted this errand first');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('says so after a withdrawal', async () => {
    window.happyDOM.setURL('http://localhost/feed?withdrawn=1');
    const container = await render(<FeedPage />, fakeOrderService());
    window.happyDOM.setURL('http://localhost/');
    expect(container.textContent).toContain('You withdrew from the errand.');
  });
});

describe('requester open requests', () => {
  it('shows only the requester’s active orders and never offers Accept', async () => {
    const service = fakeOrderService();
    service.open = [listing(OTHER_ID, 'Their cafe')];
    service.history = () => json(200, {
      items: [{ ...order(), myRole: 'REQUESTER' }],
      truncated: false,
    });

    const container = await render(<FeedPage />, service);
    expect(container.textContent).toContain('Active requests');
    expect(container.textContent).toContain('Kopi Corner');
    expect(container.textContent).not.toContain('Their cafe');
    expect(service.queries).toContain('/orders/mine?role=REQUESTER&active=true');
    expect(service.queries).not.toContain('/orders');
    expect(container.querySelector('a[href="/request/past"]')).toBeNull();
    expect(buttons(container, 'Accept')).toEqual([]);
    expect(container.querySelector('button[aria-label="New request"]')).not.toBeNull();
  });

  it('shows a withdrawal notice immediately in requester mode', async () => {
    window.happyDOM.setURL('http://localhost/feed?withdrawn=1');
    const container = await render(<FeedPage />, fakeOrderService());
    window.happyDOM.setURL('http://localhost/');
    expect(container.textContent).toContain('You withdrew from the errand.');
  });
});

describe('history', () => {
  it('shows a failed refresh alongside the last loaded list', async () => {
    const service = fakeOrderService();
    const container = await render(<OrderHistoryPage />, service);
    expect(container.textContent).toContain('No errands yet');

    service.history = () => failure(503, 'INTERNAL');
    await act(async () => window.dispatchEvent(new window.Event('online')));
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh your errands');
    expect(container.textContent).toContain('No errands yet');
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
    expect(container.ownerDocument.activeElement?.getAttribute('role')).toBe('status');
  });

  it('counts a retried pickup as done when the lost first send went through', async () => {
    const service = fakeOrderService();
    service.current = order({ ...assigned, status: 'ACCEPTED' });
    service.answer = () => {
      service.current = order({ ...assigned, status: 'PICKED_UP', version: 4 });
      return lostAnswer();
    };
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
    await confirmAction(container, "I've picked it up", 'Record pickup');
    expect(dialog(container).open).toBe(true);

    service.answer = () => failure(409, 'INVALID_ORDER_STATE');
    await act(async () => button(dialog(container), 'Record pickup').click());
    await flush();
    expect(dialog(container).open).toBe(false);
    expect(container.textContent).not.toContain('changed before your request arrived');
    expect(buttons(container, 'Mark as delivered').length).toBeGreaterThan(0);
  });

  it('withdraws after confirming, then goes back to the feed', async () => {
    const service = fakeOrderService();
    service.current = order({ ...assigned, status: 'ACCEPTED' });
    // A withdrawal answers with the public projection: the errand no longer names them.
    service.answer = () => json(200, order({ requesterId: undefined, deliveryInstructions: undefined, version: 4 }));
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);

    await confirmAction(container, 'Withdraw', 'Withdraw');
    expect(service.commands).toEqual([{ path: `/orders/${ORDER_ID}/withdraw`, body: { expectedVersion: 3 } }]);
    expect(router.push).toHaveBeenCalledWith('/feed?withdrawn=1');
  });

  it('records delivery after confirming, then leaves the next step to the requester', async () => {
    const service = fakeOrderService();
    service.current = order({ ...assigned, status: 'PICKED_UP' });
    service.answer = () => {
      service.current = order({ ...assigned, status: 'DELIVERED', version: 4 });
      return json(200, service.current);
    };
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);

    await confirmAction(container, 'Mark as delivered', 'Record delivery');
    expect(service.commands).toEqual([{ path: `/orders/${ORDER_ID}/deliver`, body: { expectedVersion: 3 } }]);
    expect(container.querySelectorAll('button:not([aria-label="Back"])').length).toBe(0);
  });

  it('reads about a delivery as the courier, not as the requester', async () => {
    const service = fakeOrderService();
    service.current = order({ ...assigned, status: 'DELIVERED' });
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
    expect(container.textContent).toContain("You've recorded delivery.");
    expect(container.textContent).not.toContain('confirm receipt');
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
    expect(container.textContent).toContain('Cancelling');
    expect(container.textContent).toContain('The errand is being cancelled. The Credit Service is returning the reward to you.');
  });

  it("starts a dialog that can't be undone on Go back, and reads out what it does", async () => {
    const service = fakeOrderService();
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);

    await act(async () => button(container, 'Cancel errand').click());
    const document = container.ownerDocument;
    expect(document.activeElement).toBe(button(dialog(container), 'Go back'));
    const description = document.getElementById(dialog(container).getAttribute('aria-describedby')!);
    expect(description?.textContent).toContain("This can't be undone.");
  });

  it('keeps a failed send in the dialog to try again', async () => {
    const service = fakeOrderService();
    service.answer = () => failure(503, 'INTERNAL');
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);

    await confirmAction(container, 'Cancel errand', 'Cancel errand');
    expect(dialog(container).open).toBe(true);
    expect(dialog(container).textContent).toContain('INTERNAL from the server.');
  });

  it('shows an errand that has gone as gone, with no action left on it', async () => {
    const service = fakeOrderService();
    service.answer = () => {
      service.read = () => failure(404, 'NOT_FOUND');
      return failure(404, 'NOT_FOUND');
    };
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);

    await confirmAction(container, 'Cancel errand', 'Cancel errand');
    expect(container.textContent).toContain('This request no longer exists.');
    expect(buttons(container, 'Cancel errand')).toEqual([]);
  });

  it('confirms receipt after asking, and offers nothing more', async () => {
    const service = fakeOrderService();
    service.current = order({
      status: 'DELIVERED',
      courierId: 'them',
      autoConfirmAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    service.answer = () => {
      service.current = order({ status: 'COMPLETION_PENDING_CREDIT', courierId: 'them', version: 4 });
      return json(200, service.current);
    };
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);

    await confirmAction(container, 'Confirm receipt', 'Confirm receipt');
    expect(service.commands).toEqual([{ path: `/orders/${ORDER_ID}/confirm-receipt`, body: { expectedVersion: 3 } }]);
    expect(buttons(container, 'Confirm receipt')).toEqual([]);
    expect(buttons(container, "I didn't receive it")).toEqual([]);
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

  for (const [clockOff, serverAhead] of [
    ['fast', -10 * 60_000],
    ['slow', 10 * 60_000],
  ] as const) {
    it(`says a credit wait is slow after 30 seconds on the server's clock when this device's is ${clockOff}`, async () => {
      const clock = fakeClock();
      const service = fakeOrderService();
      service.serverAhead = serverAhead;
      const changed = new Date(START + serverAhead).toISOString();
      service.current = order({ status: 'PENDING_CREDIT', updatedAt: changed });
      const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
      expect(container.textContent).not.toContain('taking longer than usual');

      for (let waited = 1_000; waited < 30_000; waited += 1_000) await clock.advance(1_000);
      expect(container.textContent).not.toContain('taking longer than usual');

      await clock.advance(1_000);
      expect(container.textContent).toContain('taking longer than usual');
    });
  }

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

describe('updates on a visible tab', () => {
  const reads = (service: ReturnType<typeof fakeOrderService>) =>
    service.queries.filter((query) => query === `/orders/${ORDER_ID}`).length;
  /** Ten minutes of settled polling, read by read, without the tab ever waking it. */
  const goIdle = async (clock: ReturnType<typeof fakeClock>) => {
    for (let i = 0; i < 20; i++) await clock.advance(30_000);
  };

  function Probe({ orderId = ORDER_ID }: { orderId?: string }) {
    const { order, problem, paused, refresh } = useOrder(orderId);
    return (
      <>
        <p>{`${order?.status}: ${paused ? 'paused' : 'live'}${problem ? ` (${problem.code})` : ''}`}</p>
        <button onClick={() => refresh()}>Refresh</button>
      </>
    );
  }

  for (const status of ['OPEN', 'DELIVERED', 'DISPUTED'] as const) {
    it(`pauses settled polling on a ${status} errand after ten minutes, and says so`, async () => {
      const clock = fakeClock();
      const service = fakeOrderService();
      service.current = order({ status, courierId: status === 'OPEN' ? undefined : 'them' });
      const container = await render(<Probe />, service);
      expect(container.textContent).toContain(`${status}: live`);

      for (let i = 0; i < 19; i++) await clock.advance(30_000);
      expect(reads(service)).toBe(20);
      expect(container.textContent).toContain(`${status}: live`);

      await clock.advance(30_000);
      expect(reads(service)).toBe(21);
      expect(container.textContent).toContain(`${status}: paused`);

      await clock.advance(30 * 60_000);
      expect(reads(service)).toBe(21);
    });
  }

  it('reads once on refresh, then polls again for another ten minutes', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    const container = await render(<Probe />, service);
    await goIdle(clock);
    await clock.advance(5 * 60_000);
    expect(container.textContent).toContain('paused');
    const before = reads(service);

    service.current = order({ status: 'ACCEPTED', courierId: 'them', version: 4 });
    await act(async () => button(container, 'Refresh').click());
    await flush();
    expect(reads(service)).toBe(before + 1);
    expect(container.textContent).toContain('ACCEPTED: live');

    await clock.advance(29_000);
    expect(reads(service)).toBe(before + 1);
    await clock.advance(1_000);
    expect(reads(service)).toBe(before + 2);
    await goIdle(clock);
    expect(container.textContent).toContain('ACCEPTED: paused');
  });

  it('resumes when the tab comes back', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    const container = await render(<Probe />, service);
    await goIdle(clock);
    const before = reads(service);

    await act(async () => window.document.dispatchEvent(new window.Event('visibilitychange')));
    await flush();
    expect(reads(service)).toBe(before + 1);
    expect(container.textContent).toContain('OPEN: live');
    await clock.advance(30_000);
    expect(reads(service)).toBe(before + 2);
  });

  it('never reports a final errand as paused', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    service.current = order({ status: 'COMPLETED', courierId: 'them' });
    const container = await render(<Probe />, service);
    await goIdle(clock);
    await clock.advance(30 * 60_000);
    expect(reads(service)).toBe(1);
    expect(container.textContent).toContain('COMPLETED: live');
  });

  for (const [code, shown] of [
    [403, 'OPEN'],
    [404, 'undefined'],
  ] as const) {
    it(`does not count a ${code} on an errand already paused as paused, and stops`, async () => {
      const clock = fakeClock();
      const service = fakeOrderService();
      service.current = order({ acceptanceDeadlineAt: new Date(START + 30 * 60_000).toISOString() });
      const container = await render(<Probe />, service);
      await goIdle(clock);
      expect(container.textContent).toContain('OPEN: paused');
      const before = reads(service);

      service.read = () => failure(code, code === 403 ? 'FORBIDDEN' : 'NOT_FOUND');
      await clock.advance(20 * 60_000 + 1_000);
      expect(reads(service)).toBe(before + 1);
      expect(container.textContent).toContain(`${shown}: live (${code === 403 ? 'FORBIDDEN' : 'NOT_FOUND'})`);
      await clock.advance(60 * 60_000);
      expect(reads(service)).toBe(before + 1);
    });
  }

  it('reports a failed idle read as a problem, not paused, and stops until asked', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    service.current = order({ status: 'DISPUTED', courierId: 'them' });
    const container = await render(<Probe />, service);
    for (let i = 0; i < 19; i++) await clock.advance(30_000);

    service.read = () => failure(503, 'INTERNAL');
    await clock.advance(30_000);
    expect(reads(service)).toBe(21);
    expect(container.textContent).toContain('DISPUTED: live (INTERNAL)');
    await clock.advance(60 * 60_000);
    expect(reads(service)).toBe(21);

    service.read = () => json(200, service.stamp(service.current));
    await act(async () => button(container, 'Refresh').click());
    await flush();
    expect(reads(service)).toBe(22);
    expect(container.textContent).toContain('DISPUTED: live');
    expect(container.textContent).not.toContain('INTERNAL');
  });

  it("reads again at a deadline the server acts on, on the server's clock, while paused", async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    service.serverAhead = 10 * 60_000;
    const autoConfirmAt = new Date(START + service.serverAhead + 25 * 60_000).toISOString();
    service.current = order({ status: 'DELIVERED', courierId: 'them', autoConfirmAt });
    const container = await render(<Probe />, service);
    await goIdle(clock);
    expect(container.textContent).toContain('DELIVERED: paused');
    const before = reads(service);

    service.current = order({ status: 'COMPLETION_PENDING_CREDIT', courierId: 'them', version: 4 });
    await clock.advance(15 * 60_000);
    expect(reads(service)).toBe(before);
    expect(container.textContent).toContain('DELIVERED: paused');

    await clock.advance(1_000);
    expect(reads(service)).toBe(before + 1);
    expect(container.textContent).toContain('COMPLETION_PENDING_CREDIT: live');
  });

  it('polls again after a deadline until the server has acted on it', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    service.current = order({ acceptanceDeadlineAt: new Date(START + 30 * 60_000).toISOString() });
    const container = await render(<Probe />, service);
    await goIdle(clock);
    const before = reads(service);

    // The server's sweep has not run yet, so the first read still finds it open.
    await clock.advance(20 * 60_000 + 1_000);
    expect(reads(service)).toBe(before + 1);
    expect(container.textContent).toContain('OPEN: live');

    service.current = order({ status: 'EXPIRED', version: 5 });
    await clock.advance(30_000);
    expect(reads(service)).toBe(before + 2);
    expect(container.textContent).toContain('EXPIRED: live');
    await clock.advance(60 * 60_000);
    expect(reads(service)).toBe(before + 2);
  });

  it('starts over when it is asked for another errand', async () => {
    const { useState } = await import('react');
    function Switch() {
      const [orderId, setOrderId] = useState(ORDER_ID);
      return (
        <>
          <Probe orderId={orderId} />
          <button onClick={() => setOrderId(OTHER_ID)}>Next</button>
        </>
      );
    }
    const clock = fakeClock();
    const service = fakeOrderService();
    service.current = order({ status: 'DISPUTED', courierId: 'them', version: 9 });
    const other = order({ orderId: OTHER_ID, status: 'ACCEPTED', courierId: 'them', version: 2 });
    service.read = () =>
      json(200, service.stamp(service.queries.at(-1) === `/orders/${OTHER_ID}` ? other : service.current));
    const container = await render(<Switch />, service);
    await goIdle(clock);
    expect(container.textContent).toContain('DISPUTED: paused');

    await act(async () => button(container, 'Next').click());
    await flush();
    expect(container.textContent).toContain('ACCEPTED: live');
    for (let i = 0; i < 19; i++) await clock.advance(30_000);
    expect(container.textContent).toContain('ACCEPTED: live');
    await clock.advance(30_000);
    expect(container.textContent).toContain('ACCEPTED: paused');
  });

  it('shows the pause on the errand, with a refresh that restarts updates', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
    expect(container.textContent).not.toContain('Updates paused');

    await goIdle(clock);
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Updates paused. Refresh to see the latest.');
    // A live region announces its text, so the button stays out of it.
    expect(buttons(status, 'Refresh')).toEqual([]);
    expect(container.querySelectorAll('[role="status"] button, [role="alert"] button').length).toBe(0);
    const before = reads(service);

    const refresh = button(container, 'Refresh');
    refresh.focus();
    await act(async () => refresh.click());
    await flush();
    expect(reads(service)).toBe(before + 1);
    expect(container.textContent).not.toContain('Updates paused');
    expect(buttons(container, 'Refresh')).toEqual([]);
    // The button is gone, so focus goes to the status rather than the page.
    expect(container.ownerDocument.activeElement?.getAttribute('role')).toBe('status');
    await clock.advance(30_000);
    expect(reads(service)).toBe(before + 2);
  });

  it('moves focus to the status when trying again clears the problem', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
    const ok = service.read;
    service.read = () => failure(503, 'INTERNAL');
    await clock.advance(30_000);
    expect(container.textContent).toContain('Could not refresh this request.');
    expect(container.querySelectorAll('[role="status"] button, [role="alert"] button').length).toBe(0);

    service.read = ok;
    const retry = button(container, 'Try again');
    retry.focus();
    await act(async () => retry.click());
    await flush();
    expect(buttons(container, 'Try again')).toEqual([]);
    expect(container.ownerDocument.activeElement?.getAttribute('role')).toBe('status');
  });

  it('offers only the retry when a read fails as updates pause, and stops reading', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    service.current = order({ status: 'DISPUTED', courierId: 'them' });
    const container = await render(<OrderDetail orderId={ORDER_ID} />, service);
    for (let i = 0; i < 19; i++) await clock.advance(30_000);

    service.read = () => failure(503, 'INTERNAL');
    await clock.advance(30_000);
    expect(container.textContent).toContain('Could not refresh this request.');
    expect(container.textContent).not.toContain('Updates paused');
    expect(buttons(container, 'Refresh')).toEqual([]);
    expect(buttons(container, 'Try again').length).toBeGreaterThan(0);
    const after = reads(service);
    await clock.advance(60 * 60_000);
    expect(reads(service)).toBe(after);
  });
});

describe('credits', () => {
  const pills = (container: HTMLElement) => container.textContent?.match(/\d+ credits/g);

  it('does not read the wallet on a screen without a credit pill', async () => {
    const service = fakeOrderService();
    await render(<TopBar showCreditPill={false} />, service, false);
    expect(service.walletReads).toBe(0);
  });

  it('refreshes the balance when the first order read is already open', async () => {
    const service = fakeOrderService();
    service.wallet = () => json(200, { available: service.walletReads === 1 ? 5 : 2 });
    const container = await render(
      <>
        <TopBar />
        <OrderDetail orderId={ORDER_ID} />
      </>,
      service,
    );
    expect(service.walletReads).toBe(2);
    expect(pills(container)).toContain('2 credits');
  });

  it('reads the balance once for every top bar, and keeps it when a read fails', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    const container = await render(
      <>
        <TopBar />
        <TopBar />
      </>,
      service,
    );
    expect(pills(container)).toEqual(['5 credits', '5 credits']);
    expect(service.walletReads).toBe(1);

    service.wallet = () => failure(503, 'INTERNAL');
    await clock.advance(30_000);
    expect(service.walletReads).toBe(2);
    expect(pills(container)).toEqual(['5 credits', '5 credits']);
  });

  it('reads the balance again after the errand leaves a credit-waiting state', async () => {
    const clock = fakeClock();
    const service = fakeOrderService();
    service.answer = () => {
      service.current = order({ status: 'RELEASE_PENDING_CREDIT', releaseReason: 'CANCELLED', version: 4 });
      return json(200, service.current);
    };
    const container = await render(
      <>
        <TopBar />
        <OrderDetail orderId={ORDER_ID} />
      </>,
      service,
    );
    expect(container.textContent).toContain('5 credits');

    service.wallet = () => json(200, { available: 8 });
    await confirmAction(container, 'Cancel errand', 'Cancel errand');
    expect(container.textContent).toContain('5 credits');
    expect(service.walletReads).toBe(2);

    service.current = order({ status: 'CANCELLED', releaseReason: 'CANCELLED', version: 5 });
    await clock.advance(1_000);
    expect(container.textContent).toContain('8 credits');
    expect(service.walletReads).toBe(3);
  });
});
