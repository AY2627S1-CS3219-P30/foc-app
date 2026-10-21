"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { DesktopPanel } from "@/components/DesktopPanel";
import { NavRow } from "@/components/NavRow";
import { PersonRow } from "@/components/PersonRow";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useStore } from "@/lib/store";
import { CURRENT_USER } from "@/lib/types";
import { vars } from "@/styles/tokens";
import { OrderDetail } from "./OrderDetail";

function RequestDetail({ id }: { id: string }) {
  const router = useRouter();
  const { state, acceptRequest, completeRequest, cancelRequest, releaseRequest } = useStore();
  const request = state.requests.find((r) => r.id === id);

  if (!request) return <OrderDetail orderId={id} />;

  const isOwn = request.requesterId === CURRENT_USER.id;
  const isMyDelivery = request.courierId === CURRENT_USER.id;

  const body = (
    <>
      <Badge status={request.status} />
      <NavRow label="Title" value={request.title} />
      <NavRow label="Description" value={request.description || "—"} />
      <NavRow label="Drop-off" value={request.dropoff} />
      <NavRow label="Credits" value={`${request.credits} credits`} />

      {isOwn && request.status === "OPEN" && (
        <div style={{ display: "flex", gap: vars.space[2] }}>
          <Button variant="outline" onClick={() => router.push(`/request/${request.id}/edit`)}>
            Edit
          </Button>
          <Button variant="subtle" onClick={() => cancelRequest(request.id)}>
            Cancel request
          </Button>
        </div>
      )}

      {isOwn && (request.status === "PICKED_UP" || request.status === "ACCEPTED") && (
        <>
          <p style={{ fontSize: vars.text.md, color: vars.color.textMuted }}>
            {request.courierName} is on it.
          </p>
          {request.courierName && <PersonRow name={request.courierName} location="En route" />}
          <Button variant="subtle" onClick={() => cancelRequest(request.id)}>
            Cancel request
          </Button>
        </>
      )}

      {!isOwn && request.status === "OPEN" && (
        <>
          <PersonRow name={request.requesterName} location={request.dropoff} />
          <Button full onClick={() => acceptRequest(request.id)}>
            Accept
          </Button>
        </>
      )}

      {!isOwn && request.status === "PICKED_UP" && isMyDelivery && (
        <>
          <p style={{ fontSize: vars.text.md, fontWeight: vars.weight.semibold }}>You have picked this up!</p>
          <PersonRow name={request.requesterName} location={request.dropoff} />
          <Button full onClick={() => completeRequest(request.id)}>
            Mark as delivered
          </Button>
          <Button variant="subtle" onClick={() => releaseRequest(request.id)}>
            Can&apos;t complete this — release it
          </Button>
        </>
      )}

      {request.status === "COMPLETED" && (
        <p style={{ fontSize: vars.text.md, color: vars.color.textSubtle }}>This errand is complete.</p>
      )}
      {request.status === "CANCELLED" && (
        <p style={{ fontSize: vars.text.md, color: vars.color.textSubtle }}>This request was cancelled.</p>
      )}
    </>
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <ScreenHeader title={request.supplier} />
          <ScreenContent>{body}</ScreenContent>
        </Screen>
      </div>
      <div className="desktopOnly">
        <DesktopPanel title={request.supplier}>{body}</DesktopPanel>
      </div>
    </>
  );
}

export default function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequestDetail id={id} />;
}
