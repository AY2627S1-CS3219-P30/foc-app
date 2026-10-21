"use client";

import { Suspense, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/Button";
import { CreditSlider } from "@/components/CreditSlider";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { NavRow } from "@/components/NavRow";
import { ResponsiveShell } from "@/components/ResponsiveShell";
import { ErrorState, LoadingState } from "@/components/States";
import { SupplierUnavailable } from "@/components/SupplierPicker";
import { Textarea } from "@/components/Textarea";
import { useAuth } from "@/lib/auth";
import {
  pickupLabel,
  removeItemErrors,
  resumeDraft,
  saveDraft,
  validateDraft,
  type Draft,
  type DraftErrors,
  type DraftItem,
} from "@/lib/composer";
import { STUDENT_NAV } from "@/lib/nav";
import type { Supplier } from "@/lib/supplier-api";
import { useSupplier } from "@/lib/use-supplier";
import styles from "../composer.module.css";

const MAX_ITEMS = 50;

/** Mounted once the supplier has loaded, so the stored draft is only read in the browser. */
function DetailsForm({ userId, supplier }: { userId: string; supplier: Supplier }) {
  const router = useRouter();
  const [draft, setDraft] = useState(() => resumeDraft(userId, supplier.supplierId));
  const [errors, setErrors] = useState<DraftErrors>(draft.errors ?? {});

  const update = (changes: Partial<Draft>) => setDraft((d) => ({ ...d, ...changes }));
  const updateItem = (index: number, changes: Partial<DraftItem>) =>
    update({ items: draft.items.map((item, i) => (i === index ? { ...item, ...changes } : item)) });

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const found = validateDraft(draft);
    if (Object.keys(found).length) {
      flushSync(() => setErrors(found));
      form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    saveDraft(userId, { ...draft, errors: undefined });
    router.push(`/request/new/review?supplierId=${supplier.supplierId}`);
  }

  return (
    <form className={styles.form} onSubmit={review} noValidate>
      <NavRow label="Pickup" value={pickupLabel(supplier)} />
      <fieldset className={styles.items}>
        <legend className="field-label">Items</legend>
        {draft.items.map((item, i) => (
          <fieldset key={i} className={styles.item}>
            <legend>Item {i + 1}</legend>
            <Field label="Name" error={errors[`items.${i}.name`]} required>
              <Input
                maxLength={200}
                value={item.name}
                onChange={(e) => updateItem(i, { name: e.target.value })}
              />
            </Field>
            <Field label="Quantity" error={errors[`items.${i}.quantity`]} required>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                value={item.quantity || ""}
                onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Note"
              hint="Optional, like a size or an order number."
              error={errors[`items.${i}.note`]}
            >
              <Input
                maxLength={500}
                value={item.note}
                onChange={(e) => updateItem(i, { note: e.target.value })}
              />
            </Field>
            {draft.items.length > 1 && (
              <Button
                type="button"
                variant="subtle"
                onClick={() => {
                  update({ items: draft.items.filter((_, j) => j !== i) });
                  setErrors((e) => removeItemErrors(e, i));
                }}
              >
                Remove item {i + 1}
              </Button>
            )}
          </fieldset>
        ))}
        {errors.items && <p className={styles.error}>{errors.items}</p>}
        {draft.items.length < MAX_ITEMS && (
          <Button
            type="button"
            variant="outline"
            onClick={() => update({ items: [...draft.items, { name: "", quantity: 1, note: "" }] })}
          >
            Add another item
          </Button>
        )}
      </fieldset>
      <Field
        label="Delivery zone"
        hint="Where it should be brought, like PGP House 7. Couriers see this before accepting."
        error={errors.deliveryZone}
        required
      >
        <Input
          maxLength={200}
          value={draft.deliveryZone}
          onChange={(e) => update({ deliveryZone: e.target.value })}
        />
      </Field>
      <Field
        label="Delivery instructions"
        hint="How to hand it over. Only your courier sees these."
        error={errors.deliveryInstructions}
        required
      >
        <Textarea
          maxLength={1000}
          value={draft.deliveryInstructions}
          onChange={(e) => update({ deliveryInstructions: e.target.value })}
        />
      </Field>
      <CreditSlider
        value={draft.reward}
        onChange={(reward) => update({ reward })}
        error={errors.reward}
      />
      <div className={styles.actions}>
        <Button type="button" variant="outline" onClick={() => router.push("/request/new")}>
          Change pickup point
        </Button>
        <Button type="submit">Review request</Button>
      </div>
    </form>
  );
}

function Details() {
  const router = useRouter();
  const { user } = useAuth();
  const [lookup, retry] = useSupplier(useSearchParams().get("supplierId"));

  return lookup.status === "loading" ? (
    <LoadingState label="Loading pickup point…" rows={1} />
  ) : lookup.status === "unavailable" ? (
    <SupplierUnavailable onChooseAnother={() => router.push("/request/new")} />
  ) : lookup.status === "error" ? (
    <ErrorState title="Could not load the pickup point" onRetry={retry}>
      {lookup.message}
    </ErrorState>
  ) : (
    user && <DetailsForm userId={user.id} supplier={lookup.supplier} />
  );
}

/** One tree for every width because it holds a form: see decisions.md W3. */
export default function NewRequestDetailsPage() {
  const router = useRouter();
  return (
    <ResponsiveShell
      title="New request"
      navItems={STUDENT_NAV}
      activeHref="/feed"
      onBack={() => router.push("/request/new")}
    >
      <Suspense fallback={null}>
        <Details />
      </Suspense>
    </ResponsiveShell>
  );
}
