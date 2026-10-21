"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionDialog } from "@/components/ActionDialog";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { DesktopPanel } from "@/components/DesktopPanel";
import { FormAlert } from "@/components/FormField";
import { NavRow } from "@/components/NavRow";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ErrorState, LoadingState } from "@/components/States";
import type { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { draftFrom, itemsLabel, saveDraft } from "@/lib/composer";
import { useCredits } from "@/lib/credits";
import type { Order } from "@/lib/order-api";
import { actionDeadline, actionsFor, roleIn, type OrderAction, type Role } from "@/lib/order-actions";
import { rejectionMessage, statusWording, waitsOnCredit } from "@/lib/order-status";
import { useNowAfter } from "@/lib/use-now";
import { useOrder } from "@/lib/use-order";
import { useOrderAction } from "@/lib/use-order-action";
import { useUrlFlag } from "@/lib/use-query-param";
import { vars } from "@/styles/tokens";

/** `at` on the server's clock, shown as this device's clock will read then. */
function when(at: string, skew: number) {
  const date = new Date(Date.parse(at) + skew);
  const today = date.toDateString() === new Date().toDateString();
  return date.toLocaleString([], {
    ...(today ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

const RELEASE_NOTE: Record<NonNullable<Order["releaseReason"]>, string> = {
  CANCELLED: "It was cancelled.",
  EXPIRED: "No courier kept it before its deadline, so it expired.",
};

/** What this errand's details mean for this role now: its deadline, or why it is ending. */
function statusNote(order: Order, role: Role, passed: boolean, skew: number): string | null {
  if (order.status === "RELEASE_PENDING_CREDIT" && order.releaseReason)
    return RELEASE_NOTE[order.releaseReason];
  if (order.status === "OPEN" && order.acceptanceDeadlineAt)
    return `Open until ${when(order.acceptanceDeadlineAt, skew)}`;
  if (order.status === "DISPUTED" && role) return "There's nothing for you to do while they decide.";
  if (role !== "REQUESTER") return null;
  if (order.status === "PICKED_UP" && order.nonDeliveryReportAt)
    return passed
      ? "If it still hasn't arrived, you can report it to an administrator."
      : `If it hasn't arrived by ${when(order.nonDeliveryReportAt, skew)}, you can report it to an administrator.`;
  if (order.status === "DELIVERED" && order.autoConfirmAt)
    return passed
      ? "It's too late to report it now. If you don't confirm it, it's confirmed automatically."
      : `If you don't answer by ${when(order.autoConfirmAt, skew)}, it's confirmed automatically.`;
  return null;
}

const ROLE_LABEL: Record<Exclude<Role, null>, string> = {
  REQUESTER: "You requested this errand",
  COURIER: "You're the courier",
};

function StatusBody({
  order,
  replayed,
  role,
  actions,
  passed,
  skew,
  stillWaiting,
  problem,
  notice,
  acted,
  onAct,
}: {
  order: Order;
  replayed: boolean;
  role: Role;
  actions: OrderAction[];
  passed: boolean;
  skew: number;
  stillWaiting: boolean;
  problem: ApiError | null;
  notice: string | null;
  /** Counts commands that went through. The button that sent one may be gone, so focus comes here. */
  acted: number;
  onAct: (action: OrderAction) => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const status = useRef<HTMLDivElement>(null);
  const muted = { fontSize: vars.text.md, color: vars.color.textMuted };
  const { explanation, slow } = statusWording(order.status, role);
  const note = statusNote(order, role, passed, skew);
  const { supplier } = order;

  useEffect(() => {
    if (acted) status.current?.focus();
  }, [acted]);

  return (
    <>
      <div>
        <Badge status={order.status} role={role} />
      </div>
      <div
        ref={status}
        role="status"
        tabIndex={-1}
        style={{ display: "flex", flexDirection: "column", gap: vars.space[2] }}
      >
        {replayed && (
          <p style={{ ...muted, fontWeight: vars.weight.semibold }}>
            This request was already posted, so it wasn&apos;t posted again.
          </p>
        )}
        <p style={muted}>{explanation}</p>
        {stillWaiting && slow && <p style={muted}>{slow}</p>}
        {note && <p style={{ ...muted, fontWeight: vars.weight.semibold }}>{note}</p>}
        {order.status === "REJECTED" && <p style={muted}>{rejectionMessage(order)}</p>}
      </div>
      <FormAlert tone="info" takeFocus>{notice}</FormAlert>
      {problem && (
        <p role="alert" style={{ fontSize: vars.text.sm, color: vars.color.danger }}>
          Could not refresh this request. {problem.message}
        </p>
      )}
      {role && <NavRow label="Your part" value={ROLE_LABEL[role]} />}
      <NavRow
        label="Pickup"
        value={`${supplier.building}, floor ${supplier.floor}. ${supplier.locationDescription}`}
      />
      <NavRow label="Items" value={itemsLabel(order.items)} />
      <NavRow label="Delivery zone" value={order.deliveryZone} />
      {order.deliveryInstructions && (
        <NavRow label="Delivery instructions" value={order.deliveryInstructions} />
      )}
      <NavRow label="Reward" value={`${order.reward} credits`} />
      {actions.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: vars.space[2] }}>
          {actions.map((action) => (
            <Button key={action.command} variant={action.variant} onClick={() => onAct(action)}>
              {action.label}
            </Button>
          ))}
        </div>
      )}
      {role === "REQUESTER" && (order.status === "REJECTED" || order.status === "EXPIRED") && (
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

/** One errand, with the next steps the signed-in student may take on it. */
export function OrderDetail({ orderId }: { orderId: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const { order, skew, problem, stillWaiting, refresh } = useOrder(orderId);
  const [notice, setNotice] = useState<string | null>(null);
  const [acted, setActed] = useState(0);
  const { refresh: refreshCredits } = useCredits();
  const wasWaitingForCredits = useRef(false);
  const role = order ? roleIn(order, user?.id) : null;
  const deadline = order ? actionDeadline(order, role) : null;
  // `now` is on the server's clock, like the deadlines: this device's may be wrong.
  const now = useNowAfter(() => (deadline === null ? null : deadline + skew)) - skew;
  const act = useOrderAction({
    onDone: (next) => {
      // Only a withdrawal takes the courier off the errand, leaving nothing here for them.
      if (role === "COURIER" && !roleIn(next, user?.id)) {
        router.push("/feed?withdrawn=1");
        return;
      }
      setNotice(null);
      setActed((n) => n + 1);
      refresh(next);
    },
    onStale: (message) => {
      setNotice(message);
      refresh();
    },
  });
  const title = order?.supplier.name ?? "Request";
  const [replayed, setReplayed] = useState(false);
  useEffect(() => {
    if (!order) return;
    const waiting = waitsOnCredit(order.status);
    if (wasWaitingForCredits.current && !waiting) refreshCredits();
    wasWaitingForCredits.current = waiting;
  }, [order?.status, refreshCredits]);
  useUrlFlag("replayed", () => setReplayed(true));

  const body = order ? (
    <StatusBody
      order={order}
      replayed={replayed}
      role={role}
      actions={actionsFor(order, role, now)}
      passed={deadline !== null && now >= deadline}
      skew={skew}
      stillWaiting={stillWaiting}
      problem={problem}
      notice={notice}
      acted={acted}
      onAct={(action) => {
        setNotice(null);
        act.ask(order, action);
      }}
    />
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
      <ActionDialog state={act} />
    </>
  );
}
