"use client";

import { useState } from "react";
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
import type { Order } from "@/lib/order-api";
import { actionDeadline, actionsFor, roleIn, type OrderAction, type Role } from "@/lib/order-actions";
import { explanation, rejectionMessage } from "@/lib/order-status";
import { useNowAfter } from "@/lib/use-now";
import { useOrder } from "@/lib/use-order";
import { useOrderAction } from "@/lib/use-order-action";
import { vars } from "@/styles/tokens";

function when(at: string) {
  const date = new Date(at);
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
function statusNote(order: Order, role: Role, passed: boolean): string | null {
  if (order.status === "RELEASE_PENDING_CREDIT" && order.releaseReason)
    return RELEASE_NOTE[order.releaseReason];
  if (order.status === "OPEN" && order.acceptanceDeadlineAt)
    return `Open until ${when(order.acceptanceDeadlineAt)}`;
  if (order.status === "DISPUTED" && role) return "There's nothing for you to do while they decide.";
  if (role !== "REQUESTER") return null;
  if (order.status === "PICKED_UP" && order.nonDeliveryReportAt)
    return passed
      ? "If it still hasn't arrived, you can report it to an administrator."
      : `If it hasn't arrived by ${when(order.nonDeliveryReportAt)}, you can report it to an administrator.`;
  if (order.status === "DELIVERED" && order.autoConfirmAt)
    return passed
      ? "It now counts as received, and the courier is being paid."
      : `If you don't answer by ${when(order.autoConfirmAt)}, it's confirmed automatically.`;
  return null;
}

const ROLE_LABEL: Record<Exclude<Role, null>, string> = {
  REQUESTER: "You requested this errand",
  COURIER: "You're the courier",
};

function StatusBody({
  order,
  role,
  actions,
  passed,
  stillWaiting,
  problem,
  notice,
  onAct,
}: {
  order: Order;
  role: Role;
  actions: OrderAction[];
  passed: boolean;
  stillWaiting: boolean;
  problem: ApiError | null;
  notice: string | null;
  onAct: (action: OrderAction) => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const muted = { fontSize: vars.text.md, color: vars.color.textMuted };
  const note = statusNote(order, role, passed);
  const { supplier } = order;

  return (
    <>
      <div>
        <Badge status={order.status} />
      </div>
      <div role="status" style={{ display: "flex", flexDirection: "column", gap: vars.space[2] }}>
        <p style={muted}>{explanation(order.status, role)}</p>
        {order.status === "PENDING_CREDIT" && stillWaiting && (
          <p style={muted}>
            This is taking longer than usual. Your request is saved and opens as soon as the credits
            are reserved, so you can leave this page and come back.
          </p>
        )}
        {note && <p style={{ ...muted, fontWeight: vars.weight.semibold }}>{note}</p>}
        {order.status === "REJECTED" && <p style={muted}>{rejectionMessage(order)}</p>}
      </div>
      <FormAlert tone="info">{notice}</FormAlert>
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

/** One errand, with the next steps the signed-in student may take on it. */
export function OrderDetail({ orderId }: { orderId: string }) {
  const { user } = useAuth();
  const { order, problem, stillWaiting, refresh } = useOrder(orderId);
  const [notice, setNotice] = useState<string | null>(null);
  const role = order ? roleIn(order, user?.id) : null;
  const deadline = order ? actionDeadline(order, role) : null;
  const now = useNowAfter(deadline);
  const act = useOrderAction({
    onDone: (next) => {
      setNotice(null);
      refresh(next);
    },
    onStale: (message) => {
      setNotice(message);
      refresh();
    },
  });
  const title = order?.supplier.name ?? "Request";

  const body = order ? (
    <StatusBody
      order={order}
      role={role}
      actions={actionsFor(order, role, now)}
      passed={deadline !== null && now >= deadline}
      stillWaiting={stillWaiting}
      problem={problem}
      notice={notice}
      onAct={(action) => act.ask(order, action)}
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
