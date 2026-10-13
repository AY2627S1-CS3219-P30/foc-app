/**
 * The supplier page against the real Supplier Service (and the User Service it verifies tokens
 * with). Skipped unless SUPPLIER_SERVICE_URL is set; see "Integration tests" in the README.
 *
 * Run it on its own: the page's client reads its base URL once, when supplier-api is first
 * imported, and another test file in the same run may have imported it already.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

const SUPPLIER_URL = process.env.SUPPLIER_SERVICE_URL;
const USER_URL = process.env.USER_SERVICE_URL ?? 'http://localhost:3001';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@u.nus.edu';
/** The bootstrap password the stack seeds the admin with (compose.yaml's ADMIN_SEED_PASSWORD). */
const ADMIN_SEED_PASSWORD = process.env.ADMIN_SEED_PASSWORD ?? 'dev-only-admin-password-change-me';
/** What the first run replaces the bootstrap password with, as an operator must before signing in. */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'supplier-integration-admin';

if (SUPPLIER_URL) process.env.NEXT_PUBLIC_SUPPLIER_SERVICE_URL = SUPPLIER_URL;

const window = new Window();
const auth = {
  token: '',
  authed: <T,>(call: (token: string) => Promise<T>) => call(auth.token),
  user: { roles: ['STUDENT'] },
};

/**
 * Globals, mocks and imports, only when there is a service to run against. No act(): responses
 * arrive whenever the network delivers them, so React schedules renders as it would in a browser
 * and the tests poll the DOM.
 */
async function load() {
  Object.assign(globalThis, { window, document: window.document });
  mock.module('../src/lib/auth', () => ({ useAuth: () => auth }));
  mock.module('../src/components/ResponsiveShell', () => ({
    ResponsiveShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }));
  return {
    ...(await import('react-dom/client')),
    ...(await import('../src/lib/api-client')),
    ...(await import('../src/lib/supplier-api')),
    SuppliersPage: (await import('../src/app/(app)/suppliers/page')).default,
  };
}
const loaded = SUPPLIER_URL ? await load() : null;

describe.skipIf(!loaded)('supplier listing against the Supplier Service', () => {
  const {
    createRoot,
    ApiError,
    bearer,
    unwrap,
    SUPPLIER_SERVICE_URL,
    supplierApi,
    SuppliersPage,
  } = loaded ?? ({} as NonNullable<typeof loaded>); // the body still registers when skipped

  const run = Date.now().toString(36);
  const name = `Integration supplier ${run}`;
  let studentToken = '';
  let adminToken = '';
  let createdId: string | null = null;
  let mounted: { unmount: () => void } | null = null;

  beforeAll(async () => {
    expect(SUPPLIER_SERVICE_URL).toBe(SUPPLIER_URL!);
    [studentToken, adminToken] = await Promise.all([signUpStudent(run), signInAdmin()]);
  });

  afterAll(async () => {
    mounted?.unmount();
    // Leave nothing behind if a test failed between creating and deleting.
    if (createdId) {
      const current = await find(createdId, adminToken);
      if (current.active)
        await unwrap(
          supplierApi.DELETE('/suppliers/{supplierId}', {
            params: {
              path: { supplierId: createdId },
              header: { 'If-Match': String(current.version) },
            },
            headers: bearer(adminToken),
          }),
        );
    }
    for (const key of ['window', 'document'])
      delete (globalThis as Record<string, unknown>)[key];
  });

  const list = (token: string, q?: string) =>
    unwrap(supplierApi.GET('/suppliers', { params: { query: { q } }, headers: bearer(token) }));
  const find = (supplierId: string, token: string) =>
    unwrap(
      supplierApi.GET('/suppliers/{supplierId}', {
        params: { path: { supplierId } },
        headers: bearer(token),
      }),
    );

  async function renderAs(role: 'STUDENT' | 'ADMIN') {
    mounted?.unmount();
    auth.token = role === 'ADMIN' ? adminToken : studentToken;
    auth.user = { roles: [role] };
    const container = window.document.createElement('div');
    window.document.body.replaceChildren(container);
    const root = createRoot(container as unknown as Element);
    mounted = root;
    root.render(<SuppliersPage />);
    await until(() => status(container) !== '', () => container.textContent);
    return container as unknown as HTMLElement;
  }

  /** Waits for a real round trip; `describe` says what was on screen if it never happens. */
  async function until(check: () => boolean, describe: () => unknown, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out. On screen: ${String(describe())}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const cards = (container: HTMLElement) => Array.from(container.querySelectorAll('article'));
  const titles = (container: HTMLElement) =>
    cards(container).map((card) => card.querySelector('h2')?.textContent);
  const status = (container: HTMLElement) =>
    container.querySelector('p[role="status"]')?.textContent ?? '';
  const form = (container: HTMLElement) => container.querySelector('form') as HTMLFormElement;
  const button = (scope: ParentNode, text: string) => {
    const found = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent === text);
    if (!found) throw new Error(`No "${text}" button`);
    return found;
  };
  function control<T extends HTMLElement>(scope: ParentNode, label: string): T {
    const found = Array.from(scope.querySelectorAll('label')).find(
      (l) => l.textContent?.replace(/\s*\*$/, '') === label,
    );
    if (!found) throw new Error(`No field labelled "${label}"`);
    return window.document.getElementById(found.htmlFor) as unknown as T;
  }
  function setValue(element: HTMLElement, value: string) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    element.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
  }
  function fill(container: HTMLElement, values: Record<string, string>) {
    for (const [label, value] of Object.entries(values))
      setValue(control(form(container), label), value);
  }
  async function save(container: HTMLElement) {
    form(container).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event,
    );
    await until(
      () => !form(container),
      () => form(container)?.textContent,
    );
  }
  async function search(container: HTMLElement, text: string) {
    setValue(control(container, 'Search suppliers'), text);
    // The search waits 300 ms for typing to stop, then reloads.
    await until(
      () => titles(container).length === 1 && titles(container)[0]!.startsWith(text),
      () => container.textContent,
    );
  }

  it('lets a student browse the seeded suppliers', async () => {
    const { total } = await list(studentToken);
    expect(total).toBeGreaterThan(0);

    const container = await renderAs('STUDENT');
    expect(status(container)).toStartWith(`${total} supplier${total === 1 ? '' : 's'} found`);
    expect(cards(container).length).toBe(Math.min(total, 20));
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).not.toContain('Add supplier');
    expect(labels).not.toContain('Edit');
    expect(labels).not.toContain('Delete');
  });

  it('refuses a student who tries to create a supplier', async () => {
    const attempt = unwrap(
      supplierApi.POST('/suppliers', {
        headers: bearer(studentToken),
        body: {
          name,
          type: 'CAFE',
          building: 'COM2',
          floor: '1',
          locationDescription: 'Should never exist',
        },
      }),
    );
    const error = await attempt.then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(403);
    expect((await list(adminToken, name)).total).toBe(0);
  });

  it('lets an admin create, edit and delete a supplier from the page', async () => {
    const container = await renderAs('ADMIN');

    button(container, 'Add supplier').click();
    await until(
      () => !!form(container),
      () => container.textContent,
    );
    fill(container, {
      Name: name,
      Type: 'CAFE',
      Building: 'COM2',
      Floor: '1',
      'Location description': 'Integration test counter',
    });
    await save(container);
    const created = (await list(adminToken, name)).items;
    expect(created.map((s) => s.name)).toEqual([name]);
    createdId = created[0]!.supplierId;
    expect(await find(createdId, adminToken)).toMatchObject({
      type: 'CAFE',
      building: 'COM2',
      floor: '1',
      version: 1,
      active: true,
    });

    await search(container, name);
    button(cards(container)[0]!, 'Edit').click();
    await until(
      () => !!form(container),
      () => container.textContent,
    );
    fill(container, { Name: `${name} edited`, Floor: '3' });
    await save(container);
    expect(await find(createdId, adminToken)).toMatchObject({
      name: `${name} edited`,
      floor: '3',
      version: 2,
    });
    await until(
      () => titles(container)[0] === `${name} edited`,
      () => container.textContent,
    );

    const confirm = window.confirm;
    window.confirm = () => true;
    try {
      button(cards(container)[0]!, 'Delete').click();
      await until(
        () => status(container) === '0 suppliers found',
        () => container.textContent,
      );
    } finally {
      window.confirm = confirm;
    }
    expect(await find(createdId, adminToken)).toMatchObject({ active: false });
    expect((await list(studentToken, name)).total).toBe(0);
  });
});

async function post(path: string, body: unknown) {
  const response = await fetch(`${USER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** A fresh student per run, activated through the User Service's development mailbox. */
async function signUpStudent(run: string): Promise<string> {
  const email = `supplier-it-${run}@u.nus.edu`;
  const password = 'supplier-integration-student';
  const registered = await post('/auth/register', {
    email,
    password,
    displayName: 'Supplier IT Student',
  });
  if (registered.status !== 201) throw new Error(`Register: ${JSON.stringify(registered)}`);
  let token: string | undefined;
  for (let attempt = 0; !token && attempt < 50; attempt++) {
    const mail = await fetch(`${USER_URL}/dev/mailbox?to=${encodeURIComponent(email)}`);
    token = ((await mail.json()) as { token?: string }).token;
    if (!token) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!token) throw new Error('No activation email (is the User Service in development mode?)');
  const activated = await post('/auth/activate', { token });
  if (activated.status !== 200) throw new Error(`Activate: ${JSON.stringify(activated)}`);
  return logIn(email, password);
}

/** Signs in the seeded admin, claiming it with ADMIN_PASSWORD on a fresh stack. */
async function signInAdmin(): Promise<string> {
  const first = await post('/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (first.status === 200) return first.body.accessToken;
  const claimed = await post('/auth/password', {
    email: ADMIN_EMAIL,
    currentPassword: ADMIN_SEED_PASSWORD,
    newPassword: ADMIN_PASSWORD,
  });
  if (claimed.status !== 204)
    throw new Error(
      `Admin sign-in failed (${JSON.stringify(first)}), and so did claiming it with ADMIN_SEED_PASSWORD (${JSON.stringify(claimed)}). Set ADMIN_PASSWORD to the admin's current password.`,
    );
  return logIn(ADMIN_EMAIL, ADMIN_PASSWORD);
}

async function logIn(email: string, password: string): Promise<string> {
  const response = await post('/auth/login', { email, password });
  if (response.status !== 200) throw new Error(`Login ${email}: ${JSON.stringify(response)}`);
  return response.body.accessToken;
}
