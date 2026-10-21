"use client";

import { useCallback, useEffect, useState } from "react";
import { AppBar } from "@/components/AppBar";
import { DesktopShell } from "@/components/DesktopShell";
import { ErrandCard } from "@/components/ErrandCard";
import { Screen, ScreenContent } from "@/components/Screen";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { STUDENT_NAV } from "@/lib/nav";
import { listMyOrders, type MyOrder } from "@/lib/order-api";
import { isFinal } from "@/lib/order-status";
import { useOnReturn } from "@/lib/use-on-return";
import { vars } from "@/styles/tokens";

const ROLE_LABEL: Record<MyOrder["myRole"], string> = {
  REQUESTER: "You requested",
  COURIER: "You're delivering",
};

function Section({ title, orders }: { title: string; orders: MyOrder[] }) {
  if (orders.length === 0) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: vars.space[3] }}>
      <h2 style={{ fontSize: vars.text.lg, fontWeight: vars.weight.semibold }}>{title}</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))",
          gap: vars.space[4],
        }}
      >
        {orders.map((o) => (
          <ErrandCard key={o.orderId} errand={o} meta={ROLE_LABEL[o.myRole]} />
        ))}
      </div>
    </section>
  );
}

export default function OrderHistoryPage() {
  const { authed } = useAuth();
  const [mine, setMine] = useState<{ items: MyOrder[]; truncated: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((r) => r + 1), []);
  useOnReturn(reload);

  useEffect(() => {
    let live = true;
    authed(listMyOrders).then(
      (next) => {
        if (!live) return;
        setMine(next);
        setProblem(null);
      },
      (err: unknown) => {
        if (live) setProblem(err instanceof ApiError ? err.message : "Something went wrong.");
      },
    );
    return () => {
      live = false;
    };
  }, [authed, revision]);

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
