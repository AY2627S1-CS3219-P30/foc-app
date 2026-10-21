"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/Button";
import { CreditSlider } from "@/components/CreditSlider";
import { DesktopPanel } from "@/components/DesktopPanel";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { NavRow } from "@/components/NavRow";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ErrorState, LoadingState } from "@/components/States";
import { SupplierUnavailable } from "@/components/SupplierPicker";
import { Textarea } from "@/components/Textarea";
import { useStore } from "@/lib/store";
import type { Supplier } from "@/lib/supplier-api";
import { useSupplier } from "@/lib/use-supplier";

const locationOf = (supplier: Supplier) => `${supplier.building}, floor ${supplier.floor}`;

function DetailsForm() {
  const params = useSearchParams();
  const router = useRouter();
  const { createRequest } = useStore();

  const [lookup, retry] = useSupplier(params.get("supplierId"));
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [credits, setCredits] = useState(10);

  function submit() {
    if (lookup.status !== "ready" || !title.trim()) return;
    const { supplier } = lookup;
    const id = createRequest({
      title: title.trim(),
      supplier: supplier.name,
      dropoff: locationOf(supplier),
      description,
      credits,
    });
    router.push(`/request/${id}?posted=1`);
  }

  const body =
    lookup.status === "loading" ? (
      <LoadingState label="Loading pickup point…" rows={1} />
    ) : lookup.status === "unavailable" ? (
      <SupplierUnavailable onChooseAnother={() => router.push("/request/new")} />
    ) : lookup.status === "error" ? (
      <ErrorState title="Could not load the pickup point" onRetry={retry}>
        {lookup.message}
      </ErrorState>
    ) : (
      <>
        <NavRow label="Pickup" value={lookup.supplier.name} />
        <NavRow label="Drop-off" value={locationOf(lookup.supplier)} />
        <Field label="Title" required>
          <Input placeholder="Title..." value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <CreditSlider value={credits} onChange={setCredits} />
        <Field label="Description">
          <Textarea
            placeholder="Description..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Button full onClick={submit} disabled={!title.trim()}>
          Post request
        </Button>
      </>
    );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <ScreenHeader title="Add request" onBack={() => router.push("/request/new")} />
          <ScreenContent>{body}</ScreenContent>
        </Screen>
      </div>
      <div className="desktopOnly">
        <DesktopPanel title="Add request" onBack={() => router.push("/request/new")} width={480}>
          {body}
        </DesktopPanel>
      </div>
    </>
  );
}

export default function NewRequestDetailsPage() {
  return (
    <Suspense fallback={null}>
      <DetailsForm />
    </Suspense>
  );
}
