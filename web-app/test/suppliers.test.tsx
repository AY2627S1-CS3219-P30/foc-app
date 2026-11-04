import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { ApiError } from '../src/lib/api-client';
import { displayImageUrl, hoursLabel, MAX_PERIODS_PER_DAY } from '../src/lib/supplier-display';
import type { Supplier, SupplierInput } from '../src/lib/supplier-api';

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

  it('groups the periods of a day in its hours label', () => {
    expect(
      hoursLabel([
        { day: 'MON', opens: '08:00', closes: '12:00' },
        { day: 'MON', opens: '13:00', closes: '20:00' },
        { day: 'TUE', opens: '09:00', closes: '17:00' },
      ]),
    ).toBe('MON 08:00–12:00, 13:00–20:00 · TUE 09:00–17:00');
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
      if (pathname === '/buildings') return json(200, { items: ['COM2'] });
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
      await settle();
      expect(window.document.activeElement?.textContent).toBe('0 suppliers found');
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

describe('supplier form: more than one opening period a day (SS-FR1.1.3)', () => {
  const period = (day: 'MON' | 'TUE', opens: string, closes: string) => ({ day, opens, closes });

  async function openForm(
    openingHours: Supplier['openingHours'],
    onSave: (body: SupplierInput) => Promise<void> = async () => {},
    onDirtyChange?: (dirty: boolean) => void,
  ) {
    const { container, root } = await render(
      <SupplierForm
        supplier={{ ...supplier, openingHours }}
        onCancel={() => {}}
        onSave={onSave}
        onDirtyChange={onDirtyChange}
      />,
    );
    const scope = container as unknown as HTMLElement;
    const control = (label: string) => {
      const found = Array.from(scope.querySelectorAll('label')).find(
        (l) => l.textContent === label,
      );
      if (!found) throw new Error(`No field labelled "${label}"`);
      return window.document.getElementById(found.htmlFor) as unknown as HTMLInputElement;
    };
    const button = (text: string) =>
      Array.from(scope.querySelectorAll('button')).filter((b) => b.textContent === text);
    const fill = (label: string, value: string) =>
      act(() => {
        const input = control(label);
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
      });
    const click = (target: HTMLElement) => act(async () => target.click());
    const save = () =>
      act(async () => {
        scope
          .querySelector('form')!
          .dispatchEvent(
            new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event,
          );
      });
    return { scope, root, control, button, fill, click, save };
  }

  /** What the form saves, once it has saved. */
  const recorder = () => {
    const saved: SupplierInput[] = [];
    return { saved, onSave: async (body: SupplierInput) => void saved.push(body) };
  };

  it('shows every period and keeps them all when the supplier is saved unchanged', async () => {
    const hours = [
      period('MON', '08:00', '12:00'),
      period('MON', '13:00', '20:00'),
      period('TUE', '09:00', '17:00'),
    ];
    const { saved, onSave } = recorder();
    const form = await openForm(hours, onSave);

    expect(form.control('MON opens').value).toBe('08:00');
    expect(form.control('MON closes').value).toBe('12:00');
    expect(form.control('MON, period 2 opens').value).toBe('13:00');
    expect(form.control('MON, period 2 closes').value).toBe('20:00');
    expect(form.control('TUE opens').value).toBe('09:00');
    await form.save();

    expect(saved[0]!.openingHours).toEqual(hours);
    await act(() => form.root.unmount());
  });

  it('adds a period to a day that has hours, and sends it', async () => {
    const { saved, onSave } = recorder();
    const form = await openForm([period('MON', '08:00', '12:00')], onSave);

    await form.click(form.button('Add period')[0]!);
    await form.fill('MON, period 2 opens', '13:00');
    await form.fill('MON, period 2 closes', '20:00');
    await form.save();

    expect(saved[0]!.openingHours).toEqual([
      period('MON', '08:00', '12:00'),
      period('MON', '13:00', '20:00'),
    ]);
    await act(() => form.root.unmount());
  });

  it('offers no second period until a day has its first, and stops at four', async () => {
    const form = await openForm(null);

    expect(form.button('Add period')).toHaveLength(0);
    await form.fill('MON opens', '08:00');
    expect(form.button('Add period')).toHaveLength(0);
    await form.fill('MON closes', '09:00');

    for (const n of [2, 3, 4]) {
      await form.click(form.button('Add period')[0]!);
      await form.fill(`MON, period ${n} opens`, `1${n}:00`);
      await form.fill(`MON, period ${n} closes`, `1${n}:30`);
    }
    expect(form.button('Add period')).toHaveLength(0);
    await act(() => form.root.unmount());
  });

  it('removes a period, and leaves blank ones out of what it sends', async () => {
    const { saved, onSave } = recorder();
    const form = await openForm(
      [period('MON', '08:00', '12:00'), period('MON', '13:00', '20:00')],
      onSave,
    );

    await form.click(form.button('Remove')[1]!);
    expect(form.button('Remove')).toHaveLength(0);
    await form.click(form.button('Add period')[0]!);
    await form.save();

    expect(saved[0]!.openingHours).toEqual([period('MON', '08:00', '12:00')]);
    await act(() => form.root.unmount());
  });

  it('marks both inputs of a period the service refuses as a whole', async () => {
    const form = await openForm(
      [
        period('MON', '08:00', '12:00'),
        period('MON', '11:00', '13:00'),
        period('TUE', '09:00', '17:00'),
      ],
      async () => {
        throw new ApiError(422, 'VALIDATION_FAILED', 'One or more fields are invalid.', [
          { field: 'openingHours.1', code: 'OVERLAPPING_HOURS', message: 'MON overlaps.' },
          { field: 'openingHours.2.closes', code: 'INVALID', message: 'Bad closing time.' },
        ]);
      },
    );
    await form.save();

    for (const label of ['MON, period 2 opens', 'MON, period 2 closes', 'TUE closes']) {
      expect(form.control(label).getAttribute('aria-invalid')).toBe('true');
    }
    // Both inputs point at one message, so it is neither shown nor announced twice.
    for (const label of ['MON, period 2 opens', 'MON, period 2 closes']) {
      const described = window.document.getElementById(
        form.control(label).getAttribute('aria-describedby')!,
      );
      expect(described?.textContent).toBe('MON overlaps.');
    }
    expect(form.scope.textContent?.match(/MON overlaps\./g)).toHaveLength(1);
    for (const label of ['MON opens', 'MON closes', 'TUE opens']) {
      expect(form.control(label).getAttribute('aria-invalid')).toBeNull();
    }
    // Shown beside the period, so the hours' own alert doesn't say it again.
    expect(form.scope.querySelector('fieldset > [role="alert"]')).toBeNull();
    await act(() => form.root.unmount());
  });

  it('keeps an error on the hours as a whole in the alert', async () => {
    const form = await openForm([period('MON', '08:00', '12:00')], async () => {
      throw new ApiError(422, 'VALIDATION_FAILED', 'One or more fields are invalid.', [
        { field: 'openingHours', code: 'TOO_BIG', message: 'Too many periods.' },
      ]);
    });
    await form.save();

    expect(form.scope.querySelector('fieldset > [role="alert"]')?.textContent).toBe(
      'Too many periods.',
    );
    await act(() => form.root.unmount());
  });

  it('can remove the first of two periods', async () => {
    const { saved, onSave } = recorder();
    const form = await openForm(
      [period('MON', '08:00', '12:00'), period('MON', '13:00', '20:00')],
      onSave,
    );

    expect(form.button('Remove')).toHaveLength(2);
    await form.click(form.button('Remove')[0]!);
    expect(form.button('Remove')).toHaveLength(0);
    expect(form.control('MON opens').value).toBe('13:00');
    await form.save();

    expect(saved[0]!.openingHours).toEqual([period('MON', '13:00', '20:00')]);
    await act(() => form.root.unmount());
  });

  it('removing a period clears only the errors on the hours', async () => {
    const form = await openForm(
      [period('MON', '08:00', '12:00'), period('MON', '11:00', '13:00')],
      async () => {
        throw new ApiError(422, 'VALIDATION_FAILED', 'One or more fields are invalid.', [
          { field: 'name', code: 'TOO_SMALL', message: 'Name is required.' },
          { field: 'openingHours.1', code: 'OVERLAPPING_HOURS', message: 'MON overlaps.' },
        ]);
      },
    );
    await form.save();
    await form.click(form.button('Remove')[1]!);

    expect(form.scope.textContent).toContain('Name is required.');
    expect(form.scope.textContent).not.toContain('MON overlaps.');
    expect(form.scope.textContent).toContain('One or more fields are invalid.');
    await act(() => form.root.unmount());
  });

  it('keeps a failed save\'s message when removing a period clears nothing', async () => {
    const form = await openForm(
      [period('MON', '08:00', '12:00'), period('MON', '13:00', '20:00')],
      async () => {
        throw new Error('The network went away.');
      },
    );
    await form.save();
    expect(form.scope.textContent).toContain('Could not save the supplier. Try again.');

    await form.click(form.button('Remove')[1]!);

    expect(form.scope.textContent).toContain('Could not save the supplier. Try again.');
    await act(() => form.root.unmount());
  });

  it('drops the form-level message when the last error was on the hours', async () => {
    const form = await openForm(
      [period('MON', '08:00', '12:00'), period('MON', '11:00', '13:00')],
      async () => {
        throw new ApiError(422, 'VALIDATION_FAILED', 'One or more fields are invalid.', [
          { field: 'openingHours.1', code: 'OVERLAPPING_HOURS', message: 'MON overlaps.' },
        ]);
      },
    );
    await form.save();
    await form.click(form.button('Remove')[1]!);

    expect(form.scope.textContent).not.toContain('One or more fields are invalid.');
    await act(() => form.root.unmount());
  });

  it('does not count a blank period as a change', async () => {
    const dirty: boolean[] = [];
    const form = await openForm([period('MON', '08:00', '12:00')], undefined, (value) => {
      dirty.push(value);
    });

    await form.click(form.button('Add period')[0]!);
    expect(dirty.at(-1)).toBe(false);
    await form.fill('MON, period 2 opens', '13:00');
    expect(dirty.at(-1)).toBe(true);
    await act(() => form.root.unmount());
  });

  it('agrees with the contract on the limit', () => {
    const contract = readFileSync('../contracts/supplier-service.openapi.yaml', 'utf8');
    const maxItems = /openingHours:\s+type: \[array, 'null'\]\s+maxItems: (\d+)/.exec(contract)?.[1];
    expect(Number(maxItems)).toBe(7 * MAX_PERIODS_PER_DAY);
  });
});
