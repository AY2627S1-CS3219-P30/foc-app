import { afterAll, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { ApiError } from '../src/lib/api-client';
import { displayImageUrl, hoursLabel } from '../src/lib/supplier-display';
import type { Supplier } from '../src/lib/supplier-api';

const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SupplierCard } = await import('../src/components/SupplierCard');
const { SupplierForm } = await import('../src/app/(app)/suppliers/SupplierForm');

const adminAuth = {
  authed: <T,>(call: (token: string) => Promise<T>) => call('token'),
  user: { roles: ['ADMIN'] },
};
mock.module('../src/lib/auth', () => ({ useAuth: () => adminAuth }));
mock.module('../src/components/ResponsiveShell', () => ({
  ResponsiveShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const { default: SuppliersPage } = await import('../src/app/(app)/suppliers/page');

const supplier: Supplier = {
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

afterAll(() => {
  for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'])
    delete (globalThis as Record<string, unknown>)[key];
});

async function render(node: React.ReactNode) {
  const container = window.document.createElement('div');
  window.document.body.replaceChildren(container);
  const root = createRoot(container as unknown as Element);
  await act(() => root.render(node));
  return { container, root };
}

describe('supplier listing', () => {
  it('shows the real detail fields and hides management controls for students', async () => {
    const { container, root } = await render(<SupplierCard supplier={supplier} />);
    expect(container.textContent).toContain('By the entrance');
    expect(container.textContent).toContain('MON 09:00–18:00');
    expect(container.textContent).toContain('Image unavailable');
    expect(container.textContent).not.toContain('Delete');
    await act(() => root.unmount());
  });

  it('shows edit and delete only to an admin', async () => {
    const { container, root } = await render(
      <SupplierCard supplier={supplier} admin onEdit={() => {}} onDelete={() => {}} />,
    );
    expect(container.textContent).toContain('Edit');
    expect(container.textContent).toContain('Delete');
    await act(() => root.unmount());
  });

  it('converts seed image links and labels missing hours', () => {
    expect(displayImageUrl('https://github.com/team/repo/blob/main/data/image.jpeg')).toBe(
      'https://raw.githubusercontent.com/team/repo/main/data/image.jpeg',
    );
    expect(hoursLabel(null)).toBe('Hours not provided');
  });

  it('keeps entered values and marks every field rejected by the service', async () => {
    const { container, root } = await render(
      <SupplierForm
        onCancel={() => {}}
        onSave={async () => {
          throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid supplier', [
            { field: 'name', code: 'TOO_LONG', message: 'Name is too long' },
            { field: 'building', code: 'REQUIRED', message: 'Choose a building' },
          ]);
        }}
      />,
    );
    const nameInput = container.querySelector('input') as HTMLInputElement;
    await act(() => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nameInput), 'value')!.set!.call(
        nameInput,
        'My supplier',
      );
      nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(nameInput.value).toBe('My supplier');
    expect(container.textContent).toContain('Name is too long');
    expect(container.textContent).toContain('Choose a building');
    expect(container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2);
    await act(() => root.unmount());
  });

  it('keeps an opening-hours error on the submitted day after another day is filled in', async () => {
    const { container, root } = await render(
      <SupplierForm
        onCancel={() => {}}
        onSave={async () => {
          throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid supplier', [
            { field: 'openingHours.0.opens', code: 'INVALID', message: 'Bad opening time' },
          ]);
        }}
      />,
    );
    // Time inputs are ordered MON opens, MON closes, TUE opens, ...
    const timeInputs = () =>
      Array.from(container.querySelectorAll('input[type="time"]')) as HTMLInputElement[];
    const type = async (input: HTMLInputElement, value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    const rowFor = (day: string) =>
      timeInputs()[['MON', 'TUE', 'WED', 'THU'].indexOf(day) * 2]!.closest('fieldset > div')!;
    await type(timeInputs()[2]!, '09:00'); // TUE opens
    await type(timeInputs()[3]!, '17:00'); // TUE closes
    await type(timeInputs()[6]!, '09:00'); // THU opens
    await type(timeInputs()[7]!, '17:00'); // THU closes
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(rowFor('TUE').textContent).toContain('Bad opening time');
    await type(timeInputs()[0]!, '08:00'); // MON opens, shifts current day indices
    expect(rowFor('TUE').textContent).toContain('Bad opening time');
    expect(rowFor('MON').textContent).not.toContain('Bad opening time');
    await act(() => root.unmount());
  });

  it('drops empty tags from trailing or doubled commas', async () => {
    const sent: (string[] | null | undefined)[] = [];
    const { container, root } = await render(
      <SupplierForm
        onCancel={() => {}}
        onSave={async (input) => {
          sent.push(input.tags);
        }}
      />,
    );
    const tagsLabel = [...container.querySelectorAll('label')].find((label) =>
      label.textContent?.startsWith('Tags'),
    )!;
    const tagsInput = window.document.getElementById(
      tagsLabel.getAttribute('for')!,
    ) as unknown as HTMLInputElement;
    for (const value of ['halal, vegetarian,', 'a,,b', ' , ']) {
      await act(() => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tagsInput), 'value')!.set!.call(
          tagsInput,
          value,
        );
        tagsInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await act(async () => {
        container
          .querySelector('form')!
          .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
    }
    expect(sent).toEqual([['halal', 'vegetarian'], ['a', 'b'], null]);
    await act(() => root.unmount());
  });

  it('shows a per-day hours error at that day only, not again in the hours alert', async () => {
    const { container, root } = await render(
      <SupplierForm
        supplier={supplier}
        onCancel={() => {}}
        onSave={async () => {
          throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid supplier', [
            { field: 'openingHours.0.closes', code: 'INVALID', message: 'Closes after opens' },
            { field: 'openingHours.0.day', code: 'DUPLICATE', message: 'Duplicate day' },
          ]);
        }}
      />,
    );
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(container.textContent!.split('Closes after opens')).toHaveLength(2);
    expect(container.querySelector('fieldset [role="alert"]')?.textContent).toBe('Duplicate day');
    await act(() => root.unmount());
  });
});

describe('supplier version conflicts', () => {
  /** A fake supplier service where another admin has already moved the supplier to version 2. */
  function fakeService() {
    const calls: { method: string; path: string; ifMatch: string | null; body?: unknown }[] = [];
    let current = { ...supplier, version: 2 };
    /** Set to make the supplier disappear after the next conflict, as if deleted in between. */
    const state = { deleteOnConflict: false, deleted: false };
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const fetch = async (request: Request) => {
      const { pathname } = new URL(request.url);
      const ifMatch = request.headers.get('if-match');
      const text = request.method === 'PUT' ? await request.text() : '';
      calls.push({
        method: request.method,
        path: pathname,
        ifMatch,
        body: text && JSON.parse(text),
      });
      if (state.deleted && pathname !== '/suppliers')
        return json(404, { error: { code: 'NOT_FOUND', message: 'Supplier not found.' } });
      if (request.method === 'GET' && pathname === '/suppliers')
        return json(200, {
          items: state.deleted ? [] : [{ supplierId: current.supplierId, name: current.name }],
          page: 1,
          pageSize: 20,
          total: state.deleted ? 0 : 1,
        });
      if (request.method === 'GET') return json(200, current);
      if (ifMatch !== String(current.version)) {
        state.deleted = state.deleteOnConflict;
        return json(412, {
          error: { code: 'VERSION_CONFLICT', message: 'Someone else changed this supplier.' },
        });
      }
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      current = { ...current, version: current.version + 1 };
      return json(200, current);
    };
    return { calls, fetch, state };
  }

  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  type Container = { querySelectorAll: (selector: string) => ArrayLike<unknown> };
  const button = (container: Container, text: string) =>
    Array.from(container.querySelectorAll('button') as ArrayLike<HTMLButtonElement>).find(
      (b) => b.textContent === text,
    )!;

  async function renderPage(service: ReturnType<typeof fakeService>, stale: Supplier) {
    const realFetch = globalThis.fetch;
    // The page first sees the stale version 1, as if it loaded before the other admin's edit.
    let firstDetail = true;
    globalThis.fetch = (async (request: Request) => {
      if (firstDetail && request.method === 'GET' && request.url.includes(stale.supplierId)) {
        firstDetail = false;
        return new Response(JSON.stringify(stale), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return service.fetch(request);
    }) as typeof fetch;
    const rendered = await render(<SuppliersPage />);
    await settle();
    await settle();
    return { ...rendered, restore: () => (globalThis.fetch = realFetch) };
  }

  const submitForm = async (container: HTMLElement) => {
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    await settle();
  };
  const typeName = (container: HTMLElement, value: string) =>
    act(() => {
      const input = container.querySelector('form input') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const listCalls = (service: ReturnType<typeof fakeService>) =>
    service.calls.filter((c) => c.method === 'GET' && c.path === '/suppliers');

  it('keeps typed edits after a 412 and retries with the refreshed version', async () => {
    const service = fakeService();
    const { container, root, restore } = await renderPage(service, supplier);
    try {
      await act(async () => button(container, 'Edit').click());
      await typeName(container, 'Renamed Café');
      await submitForm(container);
      expect(container.textContent).toContain(
        'This supplier was changed by someone else. Your edits are kept; review and save again to overwrite.',
      );
      expect((container.querySelector('form input') as HTMLInputElement).value).toBe(
        'Renamed Café',
      );
      expect(listCalls(service)).toHaveLength(2);
      await submitForm(container);
      const puts = service.calls.filter((c) => c.method === 'PUT');
      expect(puts.map((c) => c.ifMatch)).toEqual(['1', '2']);
      expect(puts.map((c) => (c.body as { name: string }).name)).toEqual([
        'Renamed Café',
        'Renamed Café',
      ]);
      expect(container.querySelector('form')).toBeNull();
    } finally {
      restore();
      await act(() => root.unmount());
    }
  });

  it('closes the form and says so when the supplier was deleted after a 412', async () => {
    const service = fakeService();
    service.state.deleteOnConflict = true;
    const { container, root, restore } = await renderPage(service, supplier);
    try {
      await act(async () => button(container, 'Edit').click());
      await submitForm(container);
      expect(container.querySelector('form')).toBeNull();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'This supplier was deleted.',
      );
    } finally {
      restore();
      await act(() => root.unmount());
    }
  });

  it('reloads after a failed delete so a retry uses the fresh version', async () => {
    const service = fakeService();
    const confirm = window.confirm;
    window.confirm = () => true;
    const { container, root, restore } = await renderPage(service, supplier);
    try {
      await act(async () => button(container, 'Delete').click());
      await settle();
      await settle();
      expect(container.textContent).toContain('Someone else changed this supplier.');
      expect(listCalls(service)).toHaveLength(2);
      await act(async () => button(container, 'Delete').click());
      await settle();
      expect(service.calls.filter((c) => c.method === 'DELETE').map((c) => c.ifMatch)).toEqual([
        '1',
        '2',
      ]);
    } finally {
      window.confirm = confirm;
      restore();
      await act(() => root.unmount());
    }
  });
});
