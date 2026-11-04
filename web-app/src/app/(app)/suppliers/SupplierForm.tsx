'use client';

import { useEffect, useState, type FormEvent, type Ref } from 'react';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Input } from '@/components/Input';
import { Select } from '@/components/Select';
import { Textarea } from '@/components/Textarea';
import { ApiError, type FieldError } from '@/lib/api-client';
import type { Supplier, SupplierInput } from '@/lib/supplier-api';
import { DAYS, SUPPLIER_TYPES, TYPE_LABELS } from '@/lib/supplier-display';
import { useBuildings } from '@/lib/use-buildings';
import styles from './suppliers.module.css';

type Period = { opens: string; closes: string };
const BLANK_PERIOD: Period = { opens: '', closes: '' };
/** The service's limit (SS-FR1.1.3). */
const MAX_PERIODS_PER_DAY = 4;

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
  hours: Record<string, Period[]>;
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
      DAYS.map((day) => {
        const periods = (supplier?.openingHours ?? [])
          .filter((h) => h.day === day)
          .map(({ opens, closes }) => ({ opens, closes }));
        return [day, periods.length ? periods : [BLANK_PERIOD]];
      }),
    ),
  };
}

export function SupplierForm({
  supplier,
  onSave,
  onCancel,
  onDirtyChange,
  headingRef,
}: {
  supplier?: Supplier;
  onSave: (body: SupplierInput) => Promise<void>;
  onCancel: () => void;
  /** Called whenever the form starts or stops differing from what it opened with. */
  onDirtyChange?: (dirty: boolean) => void;
  /** The form heading, so the page can move focus to it when the form opens. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  // A refreshed supplier after a version conflict keeps the typed edits, so dirtiness is
  // measured against the values the form opened with.
  const [pristine] = useState(() => initial(supplier));
  const [form, setForm] = useState(pristine);
  const buildings = useBuildings(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(pristine);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const [errors, setErrors] = useState<FieldError[]>([]);
  // Server errors reference openingHours by submitted index, so keep the submitted order.
  const [submittedPeriods, setSubmittedPeriods] = useState<string[]>([]);
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
  // Fieldset-level hours errors: skip per-day opens/closes errors, which are
  // already shown (and announced) at that day's input.
  const hoursError =
    errors
      .filter(
        (item) =>
          (item.field === 'openingHours' ||
            item.field.startsWith('openingHours.') ||
            item.field.startsWith('openingHours[')) &&
          !/^openingHours(?:\.\d+|\[\d+\])\.(?:opens|closes)$/.test(item.field),
      )
      .map((item) => item.message)
      .join(' ') || undefined;
  const filledPeriods = DAYS.flatMap((day) =>
    form.hours[day].flatMap((period, index) =>
      period.opens || period.closes ? [{ day, index, ...period }] : [],
    ),
  );
  const periodError = (day: string, index: number, time: keyof Period) =>
    error(`openingHours.${submittedPeriods.indexOf(`${day}:${index}`)}.${time}`);
  const setPeriods = (day: string, change: (periods: Period[]) => Period[]) =>
    setForm((previous) => ({
      ...previous,
      hours: { ...previous.hours, [day]: change(previous.hours[day]) },
    }));

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
    setSubmittedPeriods(filledPeriods.map(({ day, index }) => `${day}:${index}`));
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
        tags: (() => {
          const tags = form.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean);
          return tags.length ? tags : null;
        })(),
        openingHours: filledPeriods.map(({ day, opens, closes }) => ({ day, opens, closes })),
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
      <h2 ref={headingRef} tabIndex={-1}>
        {supplier ? `Edit ${supplier.name}` : 'Add supplier'}
      </h2>
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
      <Field
        label="Building"
        required
        hint={buildings.status === 'error' ? 'Building suggestions could not be loaded.' : undefined}
        error={error('building')}
      >
        <Input
          list="supplier-buildings"
          value={form.building}
          onChange={(e) => set('building', e.target.value)}
        />
        <datalist id="supplier-buildings">
          {buildings.items.map((building) => (
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
        <p>Leave a day blank if it is closed or its hours are unavailable.</p>
        {DAYS.map((day) => {
          const periods = form.hours[day];
          const last = periods[periods.length - 1];
          return (
            <div key={day} className={styles.dayPeriods}>
              {periods.map((period, index) => {
                const label = index === 0 ? day : `${day}, period ${index + 1}`;
                const setTime = (time: keyof Period, value: string) =>
                  setPeriods(day, (current) =>
                    current.map((item, at) => (at === index ? { ...item, [time]: value } : item)),
                  );
                return (
                  <div key={index} className={styles.dayRow}>
                    <span>{index === 0 && day}</span>
                    <Field label={`${label} opens`} error={periodError(day, index, 'opens')}>
                      <Input
                        type="time"
                        value={period.opens}
                        onChange={(e) => setTime('opens', e.target.value)}
                      />
                    </Field>
                    <Field label={`${label} closes`} error={periodError(day, index, 'closes')}>
                      <Input
                        type="time"
                        value={period.closes}
                        onChange={(e) => setTime('closes', e.target.value)}
                      />
                    </Field>
                    {index > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        className={styles.periodAction}
                        aria-label={`Remove ${label}`}
                        onClick={() => {
                          // What the service refused was numbered before this period went.
                          setErrors([]);
                          setPeriods(day, (current) => current.filter((_, at) => at !== index));
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                );
              })}
              {last.opens && last.closes && periods.length < MAX_PERIODS_PER_DAY && (
                <Button
                  type="button"
                  variant="outline"
                  className={styles.periodAction}
                  aria-label={`Add a period on ${day}`}
                  onClick={() => setPeriods(day, (current) => [...current, BLANK_PERIOD])}
                >
                  Add period
                </Button>
              )}
            </div>
          );
        })}
        {hoursError && <p role="alert">{hoursError}</p>}
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
