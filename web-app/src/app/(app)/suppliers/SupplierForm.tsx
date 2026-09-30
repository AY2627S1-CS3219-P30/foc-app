'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Input } from '@/components/Input';
import { Select } from '@/components/Select';
import { Textarea } from '@/components/Textarea';
import { ApiError, type FieldError } from '@/lib/api-client';
import type { Supplier, SupplierInput } from '@/lib/supplier-api';
import { BUILDINGS, DAYS, SUPPLIER_TYPES, TYPE_LABELS } from '@/lib/supplier-display';
import styles from './suppliers.module.css';

type InputData = {
  name: string;
  type: Supplier['type'];
  building: string;
  floor: string;
  locationDescription: string;
  imageUrl: string;
  latitude: string;
  longitude: string;
  tags: string;
  hours: Record<string, { opens: string; closes: string }>;
};

function initial(supplier?: Supplier): InputData {
  return {
    name: supplier?.name ?? '',
    type: supplier?.type ?? 'FOOD',
    building: supplier?.building ?? '',
    floor: supplier?.floor ?? '',
    locationDescription: supplier?.locationDescription ?? '',
    imageUrl: supplier?.imageUrl ?? '',
    latitude: supplier?.latitude?.toString() ?? '',
    longitude: supplier?.longitude?.toString() ?? '',
    tags: supplier?.tags?.join(', ') ?? '',
    hours: Object.fromEntries(
      DAYS.map((day) => [
        day,
        {
          opens: supplier?.openingHours?.find((h) => h.day === day)?.opens ?? '',
          closes: supplier?.openingHours?.find((h) => h.day === day)?.closes ?? '',
        },
      ]),
    ),
  };
}

export function SupplierForm({
  supplier,
  onSave,
  onCancel,
}: {
  supplier?: Supplier;
  onSave: (body: SupplierInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(() => initial(supplier));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Omit<InputData, 'hours'>>(key: K, value: InputData[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const error = (key: string) =>
    errors
      .filter(
        (item) =>
          item.field === key ||
          item.field.startsWith(`${key}.`) ||
          item.field.startsWith(`${key}[`),
      )
      .map((item) => item.message)
      .join(' ') || undefined;
  const daysWithHours = DAYS.filter((day) => form.hours[day].opens || form.hours[day].closes);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors([]);
    setMessage('');
    const latitude = form.latitude.trim() ? Number(form.latitude) : null;
    const longitude = form.longitude.trim() ? Number(form.longitude) : null;
    const numberErrors = (
      [
        ['latitude', latitude],
        ['longitude', longitude],
      ] as const
    )
      .filter(([, value]) => value !== null && !Number.isFinite(value))
      .map(([field]) => ({ field, code: 'INVALID_NUMBER', message: 'Enter a valid number.' }));
    if (numberErrors.length) {
      setErrors(numberErrors);
      return;
    }
    setSaving(true);
    try {
      await onSave({
        name: form.name,
        type: form.type,
        building: form.building,
        floor: form.floor,
        locationDescription: form.locationDescription,
        imageUrl: form.imageUrl.trim() || null,
        latitude,
        longitude,
        tags: form.tags.trim() ? form.tags.split(',').map((tag) => tag.trim()) : null,
        openingHours: daysWithHours.map((day) => ({
          day,
          opens: form.hours[day].opens,
          closes: form.hours[day].closes,
        })),
      });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setErrors(cause.details);
        setMessage(cause.message);
      } else setMessage('Could not save the supplier. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className={styles.form}>
      <h2>{supplier ? `Edit ${supplier.name}` : 'Add supplier'}</h2>
      <Field label="Name" required error={error('name')}>
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Type" required error={error('type')}>
        <Select value={form.type} onChange={(e) => set('type', e.target.value as Supplier['type'])}>
          {SUPPLIER_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Building" required error={error('building')}>
        <Input
          list="supplier-buildings"
          value={form.building}
          onChange={(e) => set('building', e.target.value)}
        />
        <datalist id="supplier-buildings">
          {BUILDINGS.map((building) => (
            <option key={building} value={building} />
          ))}
        </datalist>
      </Field>
      <Field label="Floor" required error={error('floor')}>
        <Input value={form.floor} onChange={(e) => set('floor', e.target.value)} />
      </Field>
      <Field label="Location description" required error={error('locationDescription')}>
        <Textarea
          value={form.locationDescription}
          onChange={(e) => set('locationDescription', e.target.value)}
        />
      </Field>
      <Field label="Location image URL" hint="Use an HTTPS image URL." error={error('imageUrl')}>
        <Input type="url" value={form.imageUrl} onChange={(e) => set('imageUrl', e.target.value)} />
      </Field>
      <div className={styles.formGrid}>
        <Field label="Latitude" error={error('latitude')}>
          <Input
            inputMode="decimal"
            value={form.latitude}
            onChange={(e) => set('latitude', e.target.value)}
          />
        </Field>
        <Field label="Longitude" error={error('longitude')}>
          <Input
            inputMode="decimal"
            value={form.longitude}
            onChange={(e) => set('longitude', e.target.value)}
          />
        </Field>
      </div>
      <Field label="Tags" hint="Comma separated" error={error('tags')}>
        <Input value={form.tags} onChange={(e) => set('tags', e.target.value)} />
      </Field>
      <fieldset className={styles.hoursField}>
        <legend>Opening hours</legend>
        <p>Leave a day blank if hours are unavailable.</p>
        {DAYS.map((day) => (
          <div key={day} className={styles.dayRow}>
            <span>{day}</span>
            <Field
              label={`${day} opens`}
              error={error(`openingHours.${daysWithHours.indexOf(day)}.opens`)}
            >
              <Input
                type="time"
                value={form.hours[day].opens}
                onChange={(e) =>
                  setForm((previous) => ({
                    ...previous,
                    hours: {
                      ...previous.hours,
                      [day]: { ...previous.hours[day], opens: e.target.value },
                    },
                  }))
                }
              />
            </Field>
            <Field
              label={`${day} closes`}
              error={error(`openingHours.${daysWithHours.indexOf(day)}.closes`)}
            >
              <Input
                type="time"
                value={form.hours[day].closes}
                onChange={(e) =>
                  setForm((previous) => ({
                    ...previous,
                    hours: {
                      ...previous.hours,
                      [day]: { ...previous.hours[day], closes: e.target.value },
                    },
                  }))
                }
              />
            </Field>
          </div>
        ))}
        {error('openingHours') && <p role="alert">{error('openingHours')}</p>}
      </fieldset>
      {message && (
        <p role="alert" className={styles.formError}>
          {message}
        </p>
      )}
      <div className={styles.actions}>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save supplier'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
