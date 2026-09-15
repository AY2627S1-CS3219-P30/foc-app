"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/Button";
import { CreditSlider } from "@/components/CreditSlider";
import { DesktopPanel } from "@/components/DesktopPanel";
import { NavRow } from "@/components/NavRow";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useStore } from "@/lib/store";

function DetailsForm() {
  const params = useSearchParams();
  const router = useRouter();
  const { createRequest } = useStore();

  const supplier = params.get("supplier") ?? "";
  const dropoff = params.get("dropoff") ?? "";
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [credits, setCredits] = useState(10);

  function submit() {
    if (!title.trim()) return;
    const id = createRequest({ title: title.trim(), supplier, dropoff, description, credits });
    router.push(`/request/${id}?posted=1`);
  }

  // Implicit <label> wrapping (no id/htmlFor): this form renders twice
  // in the DOM, once per breakpoint, and duplicate ids would break
  // label association for whichever copy loads second.
  const body = (
    <>
      <NavRow label="Pickup" value={supplier || "—"} />
      <NavRow label="Drop-off" value={dropoff || "—"} />
      <label style={{ display: "block" }}>
        <span className="field-label">Title</span>
        <input
          className="text-input"
          placeholder="Title..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <CreditSlider value={credits} onChange={setCredits} />
      <label style={{ display: "block" }}>
        <span className="field-label">Description</span>
        <textarea
          className="text-input"
          placeholder="Description..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
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
