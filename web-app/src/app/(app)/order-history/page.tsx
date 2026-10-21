"use client";

import { useCallback, useState } from "react";
import { AppBar } from "@/components/AppBar";
import { DesktopShell } from "@/components/DesktopShell";
import { ErrandCard, ErrandGrid } from "@/components/ErrandCard";
import { Screen, ScreenContent } from "@/components/Screen";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { STUDENT_NAV } from "@/lib/nav";
import { listMyOrders, type MyOrder } from "@/lib/order-api";
import { isFinal } from "@/lib/order-status";
import { usePoll } from "@/lib/use-poll";
import { vars } from "@/styles/tokens";

/** Only while some errand is still active: past ones no longer change. */
const HISTORY_POLL_MS = 30_000;

function roleLabel({ myRole, status }: MyOrder) {
  if (myRole === "REQUESTER") return "You requested";
  return isFinal(status) ? "You were the courier" : "You're the courier";
}

function Section({ title, orders }: { title: string; orders: MyOrder[] }) {
  if (orders.length === 0) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: vars.space[3] }}>
      <h2 style={{ fontSize: vars.text.lg, fontWeight: vars.weight.semibold }}>{title}</h2>
      <ErrandGrid>
        {orders.map((o) => (
          <ErrandCard key={o.orderId} errand={o} role={o.myRole} meta={roleLabel(o)} />
        ))}
      </ErrandGrid>
    </section>
  );
}

export default function OrderHistoryPage() {
  const { authed } = useAuth();
  const [mine, setMine] = useState<{ items: MyOrder[]; truncated: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await authed(listMyOrders);
        if (signal.aborted) return null;
        setMine(next);
        setProblem(null);
        return next.items.some((o) => !isFinal(o.status)) ? HISTORY_POLL_MS : null;
      } catch (err) {
        if (signal.aborted) return null;
        setProblem(err instanceof ApiError ? err.message : "Something went wrong.");
        return HISTORY_POLL_MS;
      }
    },
    [authed],
  );
  const reload = usePoll(read);

  const content = !mine ? (
    problem ? (
      <ErrorState title="Could not load your errands" onRetry={reload}>
        {problem}
      </ErrorState>
    ) : (
      <LoadingState label="Loading your errands…" />
    )
  ) : mine.items.length === 0 ? (
    <EmptyState title="No errands yet">Errands you request or deliver will show up here.</EmptyState>
  ) : (
    <>
      <Section title="Active" orders={mine.items.filter((o) => !isFinal(o.status))} />
      <Section title="Past" orders={mine.items.filter((o) => isFinal(o.status))} />
      {mine.truncated && (
        <p style={{ fontSize: vars.text.sm, color: vars.color.textSubtle }}>
          Showing your 100 most recent errands.
        </p>
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
