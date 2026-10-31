"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { AppBar } from "@/components/AppBar";
import { Button, buttonClass } from "@/components/Button";
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
import { appendPage, refreshPage, type PagedOrders } from "@/lib/paged-orders";
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
    deliveries: PagedOrders<MyOrder>;
    requests: PagedOrders<MyOrder> | null;
  } | null>(null);
  const [failure, setFailure] = useState<{ mode: PreferredMode; message: string } | null>(null);
  const [moreFailure, setMoreFailure] = useState<{ mode: PreferredMode; kind: "deliveries" | "requests"; message: string } | null>(null);
  const [moreInFlight, setMoreInFlight] = useState<string | null>(null);
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
        setHistory((current) => ({
          mode,
          deliveries: refreshPage(current?.mode === mode ? current.deliveries : null, next),
          requests: requests
            ? refreshPage(current?.mode === mode ? current.requests : null, requests)
            : null,
        }));
        setFailure(null);
        return nextRead([...next.items, ...(requests?.items ?? [])]);
      } catch (err) {
        if (signal.aborted) return null;
        setFailure({ mode, message: err instanceof ApiError ? err.message : "Something went wrong." });
        return HISTORY_POLL_MS;
      }
    },
    [authed, mode],
  );
  const reload = usePoll(read);
  const loadMore = useCallback(async (kind: "deliveries" | "requests") => {
    const current = history?.mode === mode ? history : null;
    const cursor = current?.[kind]?.nextCursor;
    const flightKey = `${mode}:${kind}`;
    if (!mode || !cursor || moreInFlight === flightKey) return;
    setMoreInFlight(flightKey);
    setMoreFailure(null);
    try {
      const next = await authed((token) =>
        listMyOrders(token, {
          role: kind === "deliveries" ? mode : "REQUESTER",
          ...(kind === "requests" ? { active: true } : {}),
          cursor,
        }),
      );
      setHistory((existing) => {
        if (existing?.mode !== mode) return existing;
        if (kind === "deliveries" && existing.deliveries.nextCursor === cursor) {
          return { ...existing, deliveries: appendPage(existing.deliveries, next) };
        }
        if (kind === "requests" && existing.requests?.nextCursor === cursor) {
          return { ...existing, requests: appendPage(existing.requests, next) };
        }
        return existing;
      });
    } catch (err) {
      setMoreFailure({
        mode,
        kind,
        message: err instanceof ApiError ? err.message : "Something went wrong.",
      });
    } finally {
      setMoreInFlight((current) => (current === flightKey ? null : current));
    }
  }, [authed, history, mode, moreInFlight]);
  // N1.4: any errand nudge may have changed what this lists.
  useLive((nudge) => {
    if (nudge.kind !== "board") reload();
  });
  const mine = history?.mode === mode ? history : null;
  const problem = failure && failure.mode === mode ? failure.message : null;
  const items = mine?.deliveries.items ?? [];
  const activeRequests = mine?.requests?.items ?? [];

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
      {items.length === 0 && activeRequests.length === 0 ? (
        <EmptyState title="No errands yet">
          {mode === "REQUESTER"
            ? "Requests you place will show up here."
            : "Errands you deliver will show up here."}
        </EmptyState>
      ) : (
        <>
          {mode === "COURIER" && <Section title="Requests you placed" orders={activeRequests} />}
          {mine.requests?.nextCursor && (
            <Button
              variant="outline"
              disabled={moreInFlight === `${mode}:requests`}
              onClick={() => loadMore("requests")}
            >
              {moreInFlight === `${mode}:requests` ? "Loading…" : "Load more requests"}
            </Button>
          )}
          <Section title={mode === "COURIER" ? "Active deliveries" : "Active"} orders={items.filter((o) => !isFinal(o.status))} />
          <Section title={mode === "COURIER" ? "Past deliveries" : "Past"} orders={items.filter((o) => isFinal(o.status))} />
          {mine.deliveries.nextCursor && (
            <Button
              variant="outline"
              disabled={moreInFlight === `${mode}:deliveries`}
              onClick={() => loadMore("deliveries")}
            >
              {moreInFlight === `${mode}:deliveries` ? "Loading…" : "Load more errands"}
            </Button>
          )}
          {moreFailure && moreFailure.mode === mode && (
            <p role="alert">Could not load more {moreFailure.kind === "requests" ? "requests" : "errands"}. {moreFailure.message}</p>
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
