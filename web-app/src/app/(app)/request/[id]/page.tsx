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

export default function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { state, acceptRequest, completeRequest, cancelRequest } = useStore();
  const request = state.requests.find((r) => r.id === id);

  if (!request) {
    return (
      <>
        <div className="mobileOnly">
          <Screen>
            <ScreenHeader title="Request" />
            <ScreenContent>
              <p>This request no longer exists.</p>
            </ScreenContent>
          </Screen>
        </div>
        <div className="desktopOnly">
          <DesktopPanel title="Request">
            <p>This request no longer exists.</p>
          </DesktopPanel>
        </div>
      </>
    );
  }

  const isOwn = request.requesterId === CURRENT_USER.id;
  const isMyDelivery = request.courierId === CURRENT_USER.id;

  const body = (
    <>
      <Badge status={request.status} />
      <NavRow label="Title" value={request.title} />
      <NavRow label="Description" value={request.description || "—"} />
      <NavRow label="Drop-off" value={request.dropoff} />
      <NavRow label="Credits" value={`${request.credits} credits`} />

      {isOwn && request.status === "open" && (
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="outline" onClick={() => router.push(`/request/${request.id}/edit`)}>
            Edit
          </Button>
          <Button variant="subtle" onClick={() => cancelRequest(request.id)}>
            Cancel request
          </Button>
        </div>
      )}

      {isOwn && (request.status === "in_transit" || request.status === "accepted") && (
        <>
          <p style={{ fontSize: 14, color: "var(--color-text-muted)" }}>
            {request.courierName} is on it.
          </p>
          {request.courierName && <PersonRow name={request.courierName} location="En route" />}
        </>
      )}

      {!isOwn && request.status === "open" && (
        <Button full onClick={() => acceptRequest(request.id)}>
          Accept
        </Button>
      )}

      {!isOwn && request.status === "in_transit" && isMyDelivery && (
        <>
          <p style={{ fontSize: 14, fontWeight: 600 }}>You have picked this up!</p>
          <PersonRow name={request.requesterName} location={request.dropoff} />
          <Button full onClick={() => completeRequest(request.id)}>
            Mark as delivered
          </Button>
        </>
      )}

      {request.status === "complete" && (
        <p style={{ fontSize: 14, color: "var(--color-text-subtle)" }}>This errand is complete.</p>
      )}
      {request.status === "cancelled" && (
        <p style={{ fontSize: 14, color: "var(--color-text-subtle)" }}>This request was cancelled.</p>
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
