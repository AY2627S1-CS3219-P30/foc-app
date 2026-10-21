"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { DesktopPanel } from "@/components/DesktopPanel";
import { NavRow } from "@/components/NavRow";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ErrorState, LoadingState } from "@/components/States";
import type { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { draftFrom, itemsLabel, saveDraft } from "@/lib/composer";
import type { Order } from "@/lib/order-api";
import { ORDER_STATUS, rejectionMessage } from "@/lib/order-status";
import { useOrder } from "@/lib/use-order";
import { useQueryParam } from "@/lib/use-query-param";
import { vars } from "@/styles/tokens";

const deadline = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function StatusBody({
  order,
  replayed,
  stillWaiting,
  problem,
}: {
  order: Order;
  replayed: boolean;
  stillWaiting: boolean;
  problem: ApiError | null;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const muted = { fontSize: vars.text.md, color: vars.color.textMuted };
  const { explanation, slow } = ORDER_STATUS[order.status];

  return (
    <>
      <div>
        <Badge status={order.status} />
      </div>
      <div role="status" style={{ display: "flex", flexDirection: "column", gap: vars.space[2] }}>
        {replayed && (
          <p style={{ ...muted, fontWeight: vars.weight.semibold }}>
            This request was already posted, so it wasn&apos;t posted again.
          </p>
        )}
        <p style={muted}>{explanation}</p>
        {stillWaiting && slow && <p style={muted}>{slow}</p>}
        {order.status === "OPEN" && order.acceptanceDeadlineAt && (
          <p style={{ ...muted, fontWeight: vars.weight.semibold }}>
            Open until {deadline(order.acceptanceDeadlineAt)}
          </p>
        )}
        {order.status === "REJECTED" && <p style={muted}>{rejectionMessage(order)}</p>}
      </div>
      {problem && (
        <p role="alert" style={{ fontSize: vars.text.sm, color: vars.color.danger }}>
          Could not refresh this request. {problem.message}
        </p>
      )}
      <NavRow label="Items" value={itemsLabel(order.items)} />
      <NavRow label="Delivery zone" value={order.deliveryZone} />
      {order.deliveryInstructions && (
        <NavRow label="Delivery instructions" value={order.deliveryInstructions} />
      )}
      <NavRow label="Reward" value={`${order.reward} credits`} />
      {(order.status === "REJECTED" || order.status === "EXPIRED") && (
        <Button
          full
          onClick={() => {
            if (user) saveDraft(user.id, draftFrom(order));
            router.push(`/request/new/details?supplierId=${order.supplier.supplierId}`);
          }}
        >
          Post a new request
        </Button>
      )}
    </>
  );
}

/** An errand from the Order Service. Mock errands still render from the store until WEB-02. */
export function OrderDetail({ orderId }: { orderId: string }) {
  const { order, problem, stillWaiting } = useOrder(orderId);
  const title = order?.supplier.name ?? "Request";
  const fromUrl = useQueryParam("replayed") === "1";
  const [replayed, setReplayed] = useState(false);
  if (fromUrl && !replayed) setReplayed(true);

  useEffect(() => {
    if (!replayed) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("replayed");
    window.history.replaceState(null, "", url.href);
  }, [replayed]);

  const body = order ? (
    <StatusBody order={order} replayed={replayed} stillWaiting={stillWaiting} problem={problem} />
  ) : problem ? (
    <ErrorState title={problem.status === 404 ? "This request no longer exists." : "Could not load this request"}>
      {problem.status !== 404 && problem.message}
    </ErrorState>
  ) : (
    <LoadingState label="Loading your request…" rows={2} />
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <ScreenHeader title={title} />
          <ScreenContent>{body}</ScreenContent>
        </Screen>
      </div>
      <div className="desktopOnly">
        <DesktopPanel title={title}>{body}</DesktopPanel>
      </div>
    </>
  );
}
