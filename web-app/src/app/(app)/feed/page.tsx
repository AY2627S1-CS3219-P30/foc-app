// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-11-08
// Scope: Implementation for "request composer on the Order API" (WEB-00, WEB-01, WEB-02); also bug
//   fixes, refactoring and tests.
// Author review: Patrick Thomas, Jonus Ho and Anselm Long validated correctness and the
//   implementation, and checked for fatal errors and architectural conflicts, before committing.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionDialog } from "@/components/ActionDialog";
import { ResponsiveShell } from "@/components/ResponsiveShell";
import { Button } from "@/components/Button";
import { ErrandCard, ErrandGrid } from "@/components/ErrandCard";
import { FormAlert, FormField } from "@/components/FormField";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { useAuth } from "@/lib/auth";
import { boardReadDelay, useLive } from "@/lib/live/live";
import { STUDENT_NAV } from "@/lib/nav";
import { listMyOrders, listOpenOrders, type MyOrder, type OpenOrder } from "@/lib/order-api";
import { ORDER_ACTIONS } from "@/lib/order-actions";
import { PENDING_POLL_MS, statusWording, waitsOnCredit } from "@/lib/order-status";
import { useNowAfter } from "@/lib/use-now";
import { useOrderAction } from "@/lib/use-order-action";
import { useKeptWhileLoading, usePagedPoll } from "@/lib/use-paged-poll";
import { useUrlFlag } from "@/lib/use-query-param";
import type { PreferredMode } from "@/lib/user-api";
import styles from "./feed.module.css";

const FEED_POLL_MS = 30_000;
const MINUTE_MS = 60_000;
/** Below this, a card's time left is marked so a courier can see which errands are about to go. */
const URGENT_MS = 5 * MINUTE_MS;
const WITHDRAWN = "You withdrew from the errand. Another courier can take it, unless its deadline has passed.";

/** `expiresAt` counts from the server's `timeRemainingSeconds`, so a wrong device clock can't skew it. */
type Listing = OpenOrder & { expiresAt: number };
type Page = { items: (MyOrder | Listing)[]; nextCursor: string | null };

function toListings(open: { items: OpenOrder[]; nextCursor: string | null }) {
  const readAt = Date.now();
  return {
    items: open.items.map((o) => ({ ...o, expiresAt: readAt + o.timeRemainingSeconds * 1000 })),
    nextCursor: open.nextCursor,
  };
}

function useFeed(mode: PreferredMode | undefined, pickupBuilding: string, minimumReward: string) {
  const { authed } = useAuth();
  const filters = useMemo(() => {
    const building = pickupBuilding.trim();
    const reward = Number(minimumReward);
    return {
      pickupBuilding: building || undefined,
      minReward: minimumReward && Number.isInteger(reward) && reward > 0 ? reward : undefined,
    };
  }, [pickupBuilding, minimumReward]);
  const key = JSON.stringify([mode, filters.pickupBuilding?.toLowerCase(), filters.minReward]);
  const readPage = useCallback(
    async (signal: AbortSignal, cursor?: string): Promise<Page> => {
      if (mode === "REQUESTER")
        return authed((token) => listMyOrders(token, { role: mode, active: true, cursor }, signal));
      return toListings(await authed((token) => listOpenOrders(token, { ...filters, cursor }, signal)));
    },
    [authed, mode, filters],
  );
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!mode) return null;
      const page = await readPage(signal);
      const pending = page.items.some((o) => waitsOnCredit(o.status));
      return { lists: { page }, delay: pending ? PENDING_POLL_MS : FEED_POLL_MS };
    },
    [mode, readPage],
  );
  const readMore = useCallback((cursor: string, signal: AbortSignal) => readPage(signal, cursor), [readPage]);
  const feed = usePagedPoll(key, read, readMore);
  const { reload } = feed;
  // N1.4: a requester's errands change with their own errand nudges; the open list on the board,
  // read a moment later by each feed, so they do not all read it at once.
  const boardRead = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(boardRead.current), []);
  useLive((nudge) => {
    if (nudge.kind === "ready") reload();
    else if (nudge.kind === "errand" && mode === "REQUESTER") reload();
    else if (nudge.kind === "board" && mode === "COURIER") {
      clearTimeout(boardRead.current);
      boardRead.current = setTimeout(reload, boardReadDelay());
    }
  });
  return feed;
}

function timeLeft(ms: number) {
  const minutes = Math.ceil(ms / MINUTE_MS);
  return minutes <= 1 ? "Under a minute left" : `${minutes} min left`;
}

/** The next moment a card's time left ticks down a minute, or it expires. */
function nextChange(listings: Listing[] | null, now: number): number | null {
  const changes = (listings ?? [])
    .filter((l) => l.expiresAt > now)
    .map((l) => l.expiresAt - (Math.ceil((l.expiresAt - now) / MINUTE_MS) - 1) * MINUTE_MS);
  return changes.length > 0 ? Math.min(...changes) : null;
}

export default function FeedPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [pickupBuilding, setPickupBuilding] = useState("");
  const [minimumReward, setMinimumReward] = useState("");
  const feed = useFeed(user?.profile.preferredMode, pickupBuilding, minimumReward);
  const { problem, moreProblem, loadingMore, loadMore, remove, reload } = feed;
  const { mode, result, stale } = useKeptWhileLoading(user?.profile.preferredMode, feed.result, problem);
  const [notice, setNotice] = useState<string | null>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const showWithdrawn = useCallback(() => setNotice(WITHDRAWN), []);
  useUrlFlag("withdrawn", showWithdrawn);
  const listings = result && mode === "COURIER"
    ? result.page.items.filter((item): item is Listing => "expiresAt" in item)
    : null;
  const now = useNowAfter((time) => nextChange(listings, time));
  const accept = useOrderAction({
    onDone: (order) => {
      router.push(`/request/${order.orderId}`);
    },
    onStale: (message, orderId) => {
      setNotice(message);
      remove(orderId);
      reload();
    },
  });

  const courierCards = (listings?.filter((l) => l.expiresAt > now) ?? []).map((l) => (
    <ErrandCard
      key={l.orderId}
      errand={{ ...l, items: l.itemSummary }}
      meta={
        l.expiresAt - now <= URGENT_MS ? (
          <span className={styles.urgent}>{timeLeft(l.expiresAt - now)}</span>
        ) : (
          timeLeft(l.expiresAt - now)
        )
      }
      action={
        <Button
          variant="accent"
          aria-label={`Accept errand from ${l.supplier.name}`}
          onClick={() => {
            setNotice(null);
            accept.ask(l, ORDER_ACTIONS.accept);
          }}
        >
          Accept
        </Button>
      }
    />
  ));
  const requesterCards = (result && mode === "REQUESTER"
    ? result.page.items.filter((item): item is MyOrder => "myRole" in item)
    : []).map((order) => (
    <ErrandCard
      key={order.orderId}
      errand={order}
      role="REQUESTER"
      details={<p>{statusWording(order, "REQUESTER").explanation}</p>}
    />
  ));
  const cards = mode === "REQUESTER" ? requesterCards : courierCards;
  const title = mode === "REQUESTER" ? "Active requests" : "Open errands";
  const invalidReward = minimumReward !== "" &&
    (!Number.isInteger(Number(minimumReward)) || Number(minimumReward) < 1);
  // Only the filters the query sends: an invalid reward is left out of it.
  const filtered = mode === "COURIER" && (pickupBuilding.trim() !== "" || (minimumReward !== "" && !invalidReward));
  const filterFields = mode === "COURIER" && (
    <div ref={filtersRef} className={styles.filters} role="group" aria-label="Filter open errands">
      <FormField
        label="Pickup building"
        placeholder="e.g. COM2"
        value={pickupBuilding}
        maxLength={200}
        onChange={(event) => setPickupBuilding(event.target.value)}
      />
      <FormField
        label="Minimum reward"
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={minimumReward}
        error={invalidReward ? "Enter a whole number of at least 1." : undefined}
        onChange={(event) => setMinimumReward(event.target.value)}
      />
    </div>
  );

  const stateContent =
    result === null ? (
      problem ? (
        <ErrorState title={`Could not load ${title.toLowerCase()}`} onRetry={reload}>
          {problem}
        </ErrorState>
      ) : (
        <LoadingState label={`Loading ${title.toLowerCase()}…`} />
      )
    ) : (
      <div key={mode} className="settle arrive" aria-busy={stale || undefined} inert={stale}>
        <FormAlert tone="info" takeFocus>{notice}</FormAlert>
        <FormAlert>{problem ? `Could not refresh the list. ${problem}` : null}</FormAlert>
        {cards.length === 0 && filtered ? (
          <EmptyState
            title="No open errands match these filters"
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setPickupBuilding("");
                  setMinimumReward("");
                  // The button goes with the empty state, so focus returns to the first filter.
                  filtersRef.current?.querySelector("input")?.focus();
                }}
              >
                Clear filters
              </Button>
            }
          >
            Try another building or a lower minimum reward.
          </EmptyState>
        ) : cards.length === 0 ? (
          <EmptyState title={mode === "REQUESTER" ? "No active requests" : "No open errands right now"}>
            {mode === "REQUESTER" ? "Create a request to get started." : "Check back soon."}
          </EmptyState>
        ) : (
          <ErrandGrid>{cards}</ErrandGrid>
        )}
        <FormAlert>{moreProblem ? `Could not load more errands. ${moreProblem.message}` : null}</FormAlert>
        {result.page.nextCursor && (
          <Button variant="outline" onClick={() => loadMore("page")} disabled={stale || !!loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    );
  const content = <>{filterFields}{stateContent}</>;

  return (
    <>
      <ResponsiveShell
        title={title}
        navItems={STUDENT_NAV}
        activeHref="/feed"
        primaryAction={
          mode === "REQUESTER"
            ? { label: "New request", onClick: () => router.push("/request/new") }
            : undefined
        }
      >
        {content}
      </ResponsiveShell>

      <ActionDialog state={accept} />
    </>
  );
}
