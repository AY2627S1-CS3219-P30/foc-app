"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CreditSlider } from "@/components/CreditSlider";
import { DesktopPanel } from "@/components/DesktopPanel";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useStore } from "@/lib/store";

export default function EditRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { state, editRequest } = useStore();
  const request = state.requests.find((r) => r.id === id);

  const [title, setTitle] = useState(request?.title ?? "");
  const [description, setDescription] = useState(request?.description ?? "");
  const [credits, setCredits] = useState(request?.credits ?? 10);

  if (!request) {
    const notFound = <p>This request no longer exists.</p>;
    return (
      <>
        <div className="mobileOnly">
          <Screen>
            <ScreenHeader title="Edit request" />
            <ScreenContent>{notFound}</ScreenContent>
          </Screen>
        </div>
        <div className="desktopOnly">
          <DesktopPanel title="Edit request">{notFound}</DesktopPanel>
        </div>
      </>
    );
  }

  function submit() {
    if (!title.trim()) return;
    editRequest(id, {
      title: title.trim(),
      supplier: request!.supplier,
      dropoff: request!.dropoff,
      description,
      credits,
    });
    router.push(`/request/${id}`);
  }

  // Uses implicit <label> wrapping (no id/htmlFor) since this form
  // renders twice in the DOM — once per breakpoint — and duplicate
  // ids would break label association for whichever copy loads second.
  const body = (
    <>
      <label style={{ display: "block" }}>
        <span className="field-label">Title</span>
        <input className="text-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <CreditSlider value={credits} onChange={setCredits} />
      <label style={{ display: "block" }}>
        <span className="field-label">Description</span>
        <textarea
          className="text-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <Button full onClick={submit} disabled={!title.trim()}>
        Save changes
      </Button>
    </>
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <ScreenHeader title="Edit request" />
          <ScreenContent>{body}</ScreenContent>
        </Screen>
      </div>
      <div className="desktopOnly">
        <DesktopPanel title="Edit request" width={480}>
          {body}
        </DesktopPanel>
      </div>
    </>
  );
}
