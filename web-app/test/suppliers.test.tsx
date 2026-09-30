import { afterAll, describe, expect, it } from 'bun:test';
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
});
