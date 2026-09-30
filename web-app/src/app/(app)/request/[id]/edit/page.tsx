"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CreditSlider } from "@/components/CreditSlider";
import { DesktopPanel } from "@/components/DesktopPanel";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { EmptyState } from "@/components/States";
import { Textarea } from "@/components/Textarea";
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
    const notFound = <EmptyState title="This request no longer exists." />;
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

  const body = (
    <>
      <Field label="Title" required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <CreditSlider value={credits} onChange={setCredits} />
      <Field label="Description">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
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
