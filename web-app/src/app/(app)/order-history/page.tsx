// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-11-08
// Scope: Implementation for "take errands from post to paid in the app" (WEB-00, WEB-02, WEB-05);
//   also refactoring, bug fixes and tests.
// Author review: Patrick Thomas, Jonus Ho and Anselm Long reviewed the implementation for
//   correctness, ran it against the test suite, and checked that it fits our service boundaries
//   without fatal errors before committing.

"use client";

import Link from "next/link";
import { useCallback } from "react";
import { ResponsiveShell } from "@/components/ResponsiveShell";
import { Button, buttonClass } from "@/components/Button";
import { ErrandCard, ErrandGrid } from "@/components/ErrandCard";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { formatWhen } from "@/lib/admin-labels";
import { useAuth } from "@/lib/auth";
import { STUDENT_NAV } from "@/lib/nav";
import { listMyOrders, type MyOrder } from "@/lib/order-api";
import { isFinal, PENDING_POLL_MS, statusWording, waitsOnCredit } from "@/lib/order-status";
import { useLive } from "@/lib/live/live";
import { useKeptWhileLoading, usePagedPoll } from "@/lib/use-paged-poll";
import { vars } from "@/styles/tokens";

/** Only while some errand is still active: past ones no longer change. */
const HISTORY_POLL_MS = 30_000;

type List = "deliveries" | "requests";
const NO_REQUESTS: { items: MyOrder[]; nextCursor: null } = { items: [], nextCursor: null };

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
  const chosen = user?.profile.preferredMode;
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!chosen) return null;
      const [deliveries, requests] = await authed((token) =>
        Promise.all([
          listMyOrders(token, { role: chosen }, signal),
          chosen === "COURIER"
            ? listMyOrders(token, { role: "REQUESTER", active: true }, signal)
            : Promise.resolve(NO_REQUESTS),
        ]),
      );
      return { lists: { deliveries, requests }, delay: nextRead([...deliveries.items, ...requests.items]) };
    },
    [authed, chosen],
  );
  const readMore = useCallback(
    (cursor: string, signal: AbortSignal, list: List) =>
      authed((token) =>
        listMyOrders(
          token,
          list === "deliveries" ? { role: chosen, cursor } : { role: "REQUESTER", active: true, cursor },
          signal,
        ),
      ),
    [authed, chosen],
  );
  const history = usePagedPoll(chosen ?? "", read, readMore);
  const { problem, reload, loadMore, moreProblem, loadingMore } = history;
  const { mode, result: mine, stale } = useKeptWhileLoading(chosen, history.result, problem);
  // N1.4: any errand nudge may have changed what this lists.
  useLive((nudge) => {
    if (nudge.kind !== "board") reload();
  });
  const items = mine?.deliveries.items ?? [];
  const activeRequests = mine?.requests.items ?? [];

  const content = !mine ? (
    problem ? (
      <ErrorState title="Could not load your errands" onRetry={reload}>
        {problem}
      </ErrorState>
    ) : (
      <LoadingState label="Loading your errands…" />
    )
  ) : (
    <div key={mode} className="settle arrive" aria-busy={stale || undefined} inert={stale}>
      {problem && (
        <ErrorState title="Could not refresh your errands" onRetry={reload}>
          Showing the last loaded history. {problem}
        </ErrorState>
      )}
      {items.length === 0 && activeRequests.length === 0 ? (
        <EmptyState title="No errands yet">
          {mode === "REQUESTER"
            ? "Requests you place will show up here."
            : "Errands you deliver will show up here."}
        </EmptyState>
      ) : (
        <>
          {mode === "COURIER" && <Section title="Requests you placed" orders={activeRequests} />}
          {mine.requests.nextCursor && (
            <Button variant="outline" disabled={stale || !!loadingMore} onClick={() => loadMore("requests")}>
              {loadingMore === "requests" ? "Loading…" : "Load more requests"}
            </Button>
          )}
          <Section title={mode === "COURIER" ? "Active deliveries" : "Active"} orders={items.filter((o) => !isFinal(o.status))} />
          <Section title={mode === "COURIER" ? "Past deliveries" : "Past"} orders={items.filter((o) => isFinal(o.status))} />
          {mine.deliveries.nextCursor && (
            <Button variant="outline" disabled={stale || !!loadingMore} onClick={() => loadMore("deliveries")}>
              {loadingMore === "deliveries" ? "Loading…" : "Load more errands"}
            </Button>
          )}
          {moreProblem && (
            <p role="alert">Could not load more {moreProblem.list === "requests" ? "requests" : "errands"}. {moreProblem.message}</p>
          )}
        </>
      )}
    </div>
  );

  return (
    <ResponsiveShell title="Order history" navItems={STUDENT_NAV} activeHref="/order-history">
      {content}
    </ResponsiveShell>
  );
}
