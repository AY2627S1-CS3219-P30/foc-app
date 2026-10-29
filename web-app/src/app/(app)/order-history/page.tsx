"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { AppBar } from "@/components/AppBar";
import { buttonClass } from "@/components/Button";
import { DesktopShell } from "@/components/DesktopShell";
import { ErrandCard, ErrandGrid } from "@/components/ErrandCard";
import { Screen, ScreenContent } from "@/components/Screen";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { formatWhen } from "@/lib/admin-labels";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { STUDENT_NAV } from "@/lib/nav";
import { listMyOrders, type MyOrder } from "@/lib/order-api";
import { isFinal, PENDING_POLL_MS, statusWording, waitsOnCredit } from "@/lib/order-status";
import type { PreferredMode } from "@/lib/user-api";
import { useLive } from "@/lib/live/live";
import { usePoll } from "@/lib/use-poll";
import { vars } from "@/styles/tokens";

/** Only while some errand is still active: past ones no longer change. */
const HISTORY_POLL_MS = 30_000;

function nextRead(items: MyOrder[]) {
  if (items.some((o) => waitsOnCredit(o.status))) return PENDING_POLL_MS;
  return items.some((o) => !isFinal(o.status)) ? HISTORY_POLL_MS : null;
}

function roleLabel({ myRole, status }: MyOrder) {
  if (myRole === "REQUESTER") return "You requested";
  return isFinal(status) ? "You were the courier" : "You're the courier";
}

function timestamps(o: MyOrder) {
  const posted = `Posted ${formatWhen(o.createdAt)}`;
  if (isFinal(o.status)) return `${posted} · ended ${formatWhen(o.updatedAt)}`;
  if (o.status === "OPEN" && o.acceptanceDeadlineAt)
    return `${posted} · open until ${formatWhen(o.acceptanceDeadlineAt)}`;
  return `${posted} · updated ${formatWhen(o.updatedAt)}`;
}

function Section({ title, orders }: { title: string; orders: MyOrder[] }) {
  if (orders.length === 0) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: vars.space[3] }}>
      <h2 style={{ fontSize: vars.text.lg, fontWeight: vars.weight.semibold }}>{title}</h2>
      <ErrandGrid>
        {orders.map((o) => (
          <ErrandCard
            key={o.orderId}
            errand={o}
            role={o.myRole}
            meta={roleLabel(o)}
            details={
              <>
                <p>{statusWording(o, o.myRole).explanation}</p>
                <p style={{ fontSize: vars.text.xs, color: vars.color.textSubtle }}>{timestamps(o)}</p>
              </>
            }
            action={
              o.status === "COMPLETED" && (
                <Link href={`/request/${o.orderId}/receipt`} className={buttonClass({ variant: "outline" })}>
                  View receipt
                </Link>
              )
            }
          />
        ))}
      </ErrandGrid>
    </section>
  );
}

export default function OrderHistoryPage() {
  const { authed, user } = useAuth();
  const mode = user?.profile.preferredMode;
  const [history, setHistory] = useState<{
    mode: PreferredMode;
    items: MyOrder[];
    truncated: boolean;
    activeRequests: MyOrder[];
    requestsTruncated: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{ mode: PreferredMode; message: string } | null>(null);
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!mode) return null;
      try {
        const [next, requests] = await authed((token) =>
          Promise.all([
            listMyOrders(token, { role: mode }, signal),
            mode === "COURIER"
              ? listMyOrders(token, { role: "REQUESTER", active: true }, signal)
              : Promise.resolve(null),
          ]),
        );
        if (signal.aborted) return null;
        const items = next.items;
        const activeRequests = requests?.items ?? [];
        setHistory({
          mode,
          items,
          truncated: next.truncated,
          activeRequests,
          requestsTruncated: requests?.truncated ?? false,
        });
        setFailure(null);
        return nextRead([...items, ...activeRequests]);
      } catch (err) {
        if (signal.aborted) return null;
        setFailure({ mode, message: err instanceof ApiError ? err.message : "Something went wrong." });
        return HISTORY_POLL_MS;
      }
    },
    [authed, mode],
  );
  const reload = usePoll(read);
  // N1.4: any errand nudge may have changed what this lists.
  useLive((nudge) => {
    if (nudge.kind !== "board") reload();
  });
  const mine = history?.mode === mode ? history : null;
  const problem = failure && failure.mode === mode ? failure.message : null;

  const content = !mine ? (
    problem ? (
      <ErrorState title="Could not load your errands" onRetry={reload}>
        {problem}
      </ErrorState>
    ) : (
      <LoadingState label="Loading your errands…" />
    )
  ) : (
    <>
      {problem && (
        <ErrorState title="Could not refresh your errands" onRetry={reload}>
          Showing the last loaded history. {problem}
        </ErrorState>
      )}
      {mine.items.length === 0 && mine.activeRequests.length === 0 ? (
        <EmptyState title="No errands yet">
          {mode === "REQUESTER"
            ? "Requests you place will show up here."
            : "Errands you deliver will show up here."}
        </EmptyState>
      ) : (
        <>
          {mode === "COURIER" && <Section title="Requests you placed" orders={mine.activeRequests} />}
          <Section title={mode === "COURIER" ? "Active deliveries" : "Active"} orders={mine.items.filter((o) => !isFinal(o.status))} />
          <Section title={mode === "COURIER" ? "Past deliveries" : "Past"} orders={mine.items.filter((o) => isFinal(o.status))} />
          {mine.requestsTruncated && (
            <p style={{ fontSize: vars.text.sm, color: vars.color.textSubtle }}>
              Showing the 100 most recently updated requests you placed.
            </p>
          )}
          {mine.truncated && (
            <p style={{ fontSize: vars.text.sm, color: vars.color.textSubtle }}>
              Showing your 100 most recent errands.
            </p>
          )}
        </>
      )}
    </>
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <AppBar title="Order History" />
          <ScreenContent>{content}</ScreenContent>
        </Screen>
      </div>

      <div className="desktopOnly">
        <DesktopShell navItems={STUDENT_NAV} activeHref="/order-history" heading="Order history">
          {content}
        </DesktopShell>
      </div>
    </>
  );
}
