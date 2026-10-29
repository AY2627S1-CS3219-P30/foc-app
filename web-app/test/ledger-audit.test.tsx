import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const auth = { authed: <T,>(call: (token: string) => Promise<T>) => call('admin-token') };
mock.module('../src/lib/auth', () => ({ useAuth: () => auth }));
const { LedgerAudit } = await import('../src/app/(app)/admin/operations/LedgerAudit');
const realFetch = globalThis.fetch;
let container: HTMLElement, root: ReturnType<typeof createRoot>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const result = {
  runId: '00000000-0000-4000-8000-000000000283',
  origin: 'MANUAL',
  requestedBy: 'admin',
  status: 'MISMATCH',
  mismatchCount: 2,
  error: null,
  startedAt: '2026-10-27T08:00:00Z',
  completedAt: '2026-10-27T08:00:01Z',
  checks: [{ name: 'wallet balances agree with their ledger', mismatchCount: 2 }],
};
beforeEach(() => {
  container = document.createElement('div') as unknown as HTMLElement;
  document.body.appendChild(container as never);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});
afterAll(() => {
  for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'])
    delete (globalThis as Record<string, unknown>)[key];
});
const settle = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

describe('admin ledger audit', () => {
  it('loads the last run and requests a real authenticated scan, then shows mismatches without repair', async () => {
    let ran = false;
    const requests: Request[] = [];
    globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      requests.push(req);
      if (req.method === 'POST') ran = true;
      return json(200, { run: ran ? result : null });
    }) as typeof fetch;
    await act(async () => root.render(<LedgerAudit />));
    await settle();
    expect(container.textContent).toContain('No audit has run yet.');
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
    });
    await settle();
    expect(container.textContent).toContain('MISMATCH');
    expect(container.textContent).toContain('2 mismatch(es)');
    expect(container.textContent).toContain(result.runId);
    expect(container.textContent).toContain('No balance has been changed');
    const post = requests.find((r) => r.method === 'POST')!;
    expect(new URL(post.url).pathname).toBe('/admin/ledger-audits/run');
    expect(post.headers.get('authorization')).toBe('Bearer admin-token');
  });
  it('shows a failed attempt as ERROR, never as zero mismatches', async () => {
    globalThis.fetch = (async () =>
      json(200, {
        run: {
          ...result,
          status: 'ERROR',
          mismatchCount: null,
          error: 'Audit could not complete',
          checks: [],
        },
      })) as typeof fetch;
    await act(async () => root.render(<LedgerAudit />));
    await settle();
    expect(container.textContent).toContain('ERROR');
    expect(container.textContent).toContain('Scan did not complete.');
    expect(container.textContent).not.toContain('0 mismatch(es)');
  });
});
