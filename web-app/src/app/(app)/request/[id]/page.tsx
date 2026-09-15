"use client";

import { Suspense, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { DesktopPanel } from "@/components/DesktopPanel";
import { NavRow } from "@/components/NavRow";
import { PersonRow } from "@/components/PersonRow";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useStore } from "@/lib/store";
import { CURRENT_USER } from "@/lib/types";

function RequestDetail({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const justPosted = searchParams.get("posted") === "1";
  const { state, acceptRequest, completeRequest, cancelRequest, releaseRequest } = useStore();
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
      {justPosted && (
        <div
          className="card"
          style={{
            background: "#f0fdf4",
            borderColor: "#bbf7d0",
            color: "#15803d",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Posted — this is now visible to other students in the feed.
        </div>
      )}

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
          <Button variant="subtle" onClick={() => cancelRequest(request.id)}>
            Cancel request
          </Button>
        </>
      )}

      {!isOwn && request.status === "open" && (
        <>
          <PersonRow name={request.requesterName} location={request.dropoff} />
          <Button full onClick={() => acceptRequest(request.id)}>
            Accept
          </Button>
        </>
      )}

      {!isOwn && request.status === "in_transit" && isMyDelivery && (
        <>
          <p style={{ fontSize: 14, fontWeight: 600 }}>You have picked this up!</p>
          <PersonRow name={request.requesterName} location={request.dropoff} />
          <Button full onClick={() => completeRequest(request.id)}>
            Mark as delivered
          </Button>
          <Button variant="subtle" onClick={() => releaseRequest(request.id)}>
            Can&apos;t complete this — release it
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

export default function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={null}>
      <RequestDetail id={id} />
    </Suspense>
  );
}
