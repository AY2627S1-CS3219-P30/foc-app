"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { DesktopPanel } from "@/components/DesktopPanel";
import { NavRow } from "@/components/NavRow";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ErrorState, LoadingState } from "@/components/States";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { draftFrom, itemsLabel, saveDraft } from "@/lib/composer";
import { getOrder, type Order } from "@/lib/order-api";
import { ORDER_STATUS, rejectionMessage } from "@/lib/order-status";
import { vars } from "@/styles/tokens";

/** Waits between reads while credits are reserved: backing off, then every 15 seconds. */
const POLL_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** After this long in `PENDING_CREDIT`, say it is slower than usual. */
const STILL_WAITING_MS = 30_000;

/**
 * Reads the order, and keeps reading while it waits for credits and the tab is visible. A 4xx stops;
 * anything else retries.
 */
function useOrder(orderId: string) {
  const { authed } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [stillWaiting, setStillWaiting] = useState(false);

  useEffect(() => {
    const started = Date.now();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;

    async function read() {
      if (document.visibilityState === "hidden") {
        document.addEventListener("visibilitychange", read, { once: true });
        return;
      }
      try {
        const next = await authed((token) => getOrder(token, orderId));
        if (!live) return;
        setOrder(next);
        setProblem(null);
        if (next.status !== "PENDING_CREDIT") return;
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError) {
          setProblem(err);
          if (err.status >= 400 && err.status < 500) return;
        }
      }
      setStillWaiting(Date.now() - started >= STILL_WAITING_MS);
      timer = setTimeout(read, POLL_DELAYS_MS[Math.min(attempt++, POLL_DELAYS_MS.length - 1)]);
    }

    void read();
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [authed, orderId]);

  return { order, problem, stillWaiting };
}

const deadline = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function StatusBody({
  order,
  stillWaiting,
  problem,
}: {
  order: Order;
  stillWaiting: boolean;
  problem: ApiError | null;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const muted = { fontSize: vars.text.md, color: vars.color.textMuted };

  return (
    <>
      <div>
        <Badge status={order.status} />
      </div>
      <div role="status" style={{ display: "flex", flexDirection: "column", gap: vars.space[2] }}>
        <p style={muted}>{ORDER_STATUS[order.status].explanation}</p>
        {order.status === "PENDING_CREDIT" && stillWaiting && (
          <p style={muted}>
            This is taking longer than usual. Your request is saved and opens as soon as the credits
            are reserved, so you can leave this page and come back.
          </p>
        )}
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
      {order.status === "REJECTED" && (
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

  const body = order ? (
    <StatusBody order={order} stillWaiting={stillWaiting} problem={problem} />
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
