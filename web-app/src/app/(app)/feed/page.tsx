"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionDialog } from "@/components/ActionDialog";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/Button";
import { DesktopShell } from "@/components/DesktopShell";
import { ErrandCard, ErrandGrid } from "@/components/ErrandCard";
import { FormAlert, FormField } from "@/components/FormField";
import { Screen, ScreenContent } from "@/components/Screen";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { STUDENT_NAV } from "@/lib/nav";
import { listMyOrders, listOpenOrders, type MyOrder, type OpenOrder } from "@/lib/order-api";
import { ORDER_ACTIONS } from "@/lib/order-actions";
import { PENDING_POLL_MS, statusWording, waitsOnCredit } from "@/lib/order-status";
import { appendPage, refreshPage, type PagedOrders } from "@/lib/paged-orders";
import { useNowAfter } from "@/lib/use-now";
import { useOrderAction } from "@/lib/use-order-action";
import { usePoll } from "@/lib/use-poll";
import { useUrlFlag } from "@/lib/use-query-param";
import type { PreferredMode } from "@/lib/user-api";
import styles from "./feed.module.css";

const FEED_POLL_MS = 30_000;
const MINUTE_MS = 60_000;
const WITHDRAWN = "You withdrew from the errand. Another courier can take it, unless its deadline has passed.";

/** `expiresAt` counts from the server's `timeRemainingSeconds`, so a wrong device clock can't skew it. */
type Listing = OpenOrder & { expiresAt: number };
type FeedItems = { key: string; mode: PreferredMode; page: PagedOrders<MyOrder | Listing> };

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
  const [result, setResult] = useState<FeedItems | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [moreFailure, setMoreFailure] = useState<{ key: string; message: string } | null>(null);
  const [moreInFlight, setMoreInFlight] = useState<string | null>(null);
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!mode) return null;
      try {
        if (mode === "REQUESTER") {
          const mine = await authed((token) => listMyOrders(token, { role: mode, active: true }, signal));
          if (signal.aborted) return null;
          const items = mine.items;
          setResult((current) => ({
            key,
            mode,
            page: refreshPage(current?.key === key ? current.page : null, mine),
          }));
          setFailure(null);
          return items.some((o) => waitsOnCredit(o.status)) ? PENDING_POLL_MS : FEED_POLL_MS;
        }
        const open = await authed((token) => listOpenOrders(token, filters, signal));
        if (signal.aborted) return null;
        const readAt = Date.now();
        const page = {
          items: open.items.map((o) => ({ ...o, expiresAt: readAt + o.timeRemainingSeconds * 1000 })),
          nextCursor: open.nextCursor,
        };
        setResult((current) => ({
          key,
          mode,
          page: refreshPage(current?.key === key ? current.page : null, page),
        }));
        setFailure(null);
      } catch (err) {
        if (signal.aborted) return null;
        setFailure({ key, message: err instanceof ApiError ? err.message : "Something went wrong." });
      }
      return FEED_POLL_MS;
    },
    [authed, mode, filters, key],
  );
  const reload = usePoll(read);
  const loadMore = useCallback(async () => {
    const cursor = result?.key === key ? result.page.nextCursor : null;
    if (!mode || !cursor || moreInFlight === key) return;
    setMoreInFlight(key);
    setMoreFailure(null);
    try {
      if (mode === "REQUESTER") {
        const next = await authed((token) =>
          listMyOrders(token, { role: mode, active: true, cursor }),
        );
        setResult((current) =>
          current?.key === key && current.page.nextCursor === cursor
            ? { ...current, page: appendPage(current.page, next) }
            : current,
        );
      } else {
        const next = await authed((token) => listOpenOrders(token, { ...filters, cursor }));
        const readAt = Date.now();
        const page = {
          items: next.items.map((o) => ({ ...o, expiresAt: readAt + o.timeRemainingSeconds * 1000 })),
          nextCursor: next.nextCursor,
        };
        setResult((current) =>
          current?.key === key && current.page.nextCursor === cursor
            ? { ...current, page: appendPage(current.page, page) }
            : current,
        );
      }
    } catch (err) {
      setMoreFailure({ key, message: err instanceof ApiError ? err.message : "Something went wrong." });
    } finally {
      setMoreInFlight((current) => (current === key ? null : current));
    }
  }, [authed, filters, key, mode, moreInFlight, result]);
  const remove = useCallback((orderId: string) => {
    setResult((current) =>
      current?.key === key
        ? {
            ...current,
            page: {
              ...current.page,
              items: current.page.items.filter((item) => item.orderId !== orderId),
            },
          }
        : current,
    );
  }, [key]);
  return {
    result: result?.key === key ? result : null,
    problem: failure?.key === key ? failure.message : null,
    moreProblem: moreFailure?.key === key ? moreFailure.message : null,
    loadingMore: moreInFlight === key,
    loadMore,
    remove,
    reload,
  };
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
  const mode = user?.profile.preferredMode;
  const [pickupBuilding, setPickupBuilding] = useState("");
  const [minimumReward, setMinimumReward] = useState("");
  const { result, problem, moreProblem, loadingMore, loadMore, remove, reload } = useFeed(
    mode,
    pickupBuilding,
    minimumReward,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const showWithdrawn = useCallback(() => setNotice(WITHDRAWN), []);
  useUrlFlag("withdrawn", showWithdrawn);
  const listings = result?.mode === "COURIER"
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
      meta={timeLeft(l.expiresAt - now)}
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
  const requesterCards = (result?.mode === "REQUESTER"
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
  const filterFields = mode === "COURIER" && (
    <div className={styles.filters} role="group" aria-label="Filter open errands">
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
      <>
        <FormAlert tone="info" takeFocus>{notice}</FormAlert>
        <FormAlert>{problem ? `Could not refresh the list. ${problem}` : null}</FormAlert>
        {cards.length === 0 ? (
          <EmptyState title={mode === "REQUESTER" ? "No active requests" : "No open errands right now"}>
            {mode === "REQUESTER" ? "Create a request to get started." : "Check back soon."}
          </EmptyState>
        ) : (
          <ErrandGrid>{cards}</ErrandGrid>
        )}
        <FormAlert>{moreProblem ? `Could not load more errands. ${moreProblem}` : null}</FormAlert>
        {result.page.nextCursor && (
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </>
    );
  const content = <>{filterFields}{stateContent}</>;

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <AppBar
            title={mode === "REQUESTER" ? title : "Feed"}
            onPlusClick={mode === "REQUESTER" ? () => router.push("/request/new") : undefined}
          />
          <ScreenContent>{content}</ScreenContent>
        </Screen>
      </div>

      <div className="desktopOnly">
        <DesktopShell
          navItems={STUDENT_NAV}
          activeHref="/feed"
          heading={title}
          actions={
            mode === "REQUESTER" && <Button onClick={() => router.push("/request/new")}>New request</Button>
          }
        >
          {content}
        </DesktopShell>
      </div>

      <ActionDialog state={accept} />
    </>
  );
}
