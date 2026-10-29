"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionDialog } from "@/components/ActionDialog";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/Button";
import { DesktopShell } from "@/components/DesktopShell";
import { ErrandCard, ErrandGrid } from "@/components/ErrandCard";
import { FormAlert } from "@/components/FormField";
import { Screen, ScreenContent } from "@/components/Screen";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { boardReadDelay, useLive } from "@/lib/live/live";
import { STUDENT_NAV } from "@/lib/nav";
import { listMyOrders, listOpenOrders, type MyOrder, type OpenOrder } from "@/lib/order-api";
import { ORDER_ACTIONS } from "@/lib/order-actions";
import { PENDING_POLL_MS, statusWording, waitsOnCredit } from "@/lib/order-status";
import { useNowAfter } from "@/lib/use-now";
import { useOrderAction } from "@/lib/use-order-action";
import { usePoll } from "@/lib/use-poll";
import { useUrlFlag } from "@/lib/use-query-param";
import type { PreferredMode } from "@/lib/user-api";
import { vars } from "@/styles/tokens";

const FEED_POLL_MS = 30_000;
const MINUTE_MS = 60_000;
const WITHDRAWN = "You withdrew from the errand. Another courier can take it, unless its deadline has passed.";

/** `expiresAt` counts from the server's `timeRemainingSeconds`, so a wrong device clock can't skew it. */
type Listing = OpenOrder & { expiresAt: number };
type FeedItems = { mode: "REQUESTER"; items: MyOrder[]; truncated: boolean } | { mode: "COURIER"; items: Listing[] };

function useFeed(mode: PreferredMode | undefined) {
  const { authed } = useAuth();
  const [result, setResult] = useState<FeedItems | null>(null);
  const [failure, setFailure] = useState<{ mode: PreferredMode; message: string } | null>(null);
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!mode) return null;
      try {
        if (mode === "REQUESTER") {
          const mine = await authed((token) => listMyOrders(token, { role: mode, active: true }, signal));
          if (signal.aborted) return null;
          const items = mine.items;
          setResult({ mode, items, truncated: mine.truncated });
          setFailure(null);
          return items.some((o) => waitsOnCredit(o.status)) ? PENDING_POLL_MS : FEED_POLL_MS;
        }
        const open = await authed((token) => listOpenOrders(token, signal));
        if (signal.aborted) return null;
        const readAt = Date.now();
        setResult({
          mode,
          items: open.map((o) => ({ ...o, expiresAt: readAt + o.timeRemainingSeconds * 1000 })),
        });
        setFailure(null);
      } catch (err) {
        if (signal.aborted) return null;
        setFailure({ mode, message: err instanceof ApiError ? err.message : "Something went wrong." });
      }
      return FEED_POLL_MS;
    },
    [authed, mode],
  );
  const reload = usePoll(read);
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
  return {
    result: result?.mode === mode ? result : null,
    problem: failure && failure.mode === mode ? failure.message : null,
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
  const { result, problem, reload } = useFeed(mode);
  const [notice, setNotice] = useState<string | null>(null);
  const showWithdrawn = useCallback(() => setNotice(WITHDRAWN), []);
  useUrlFlag("withdrawn", showWithdrawn);
  const listings = result?.mode === "COURIER" ? result.items : null;
  const now = useNowAfter((time) => nextChange(listings, time));
  const accept = useOrderAction({
    onDone: (order) => {
      router.push(`/request/${order.orderId}`);
    },
    onStale: (message) => {
      setNotice(message);
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
  const requesterCards = (result?.mode === "REQUESTER" ? result.items : []).map((order) => (
    <ErrandCard
      key={order.orderId}
      errand={order}
      role="REQUESTER"
      details={<p>{statusWording(order, "REQUESTER").explanation}</p>}
    />
  ));
  const cards = mode === "REQUESTER" ? requesterCards : courierCards;
  const title = mode === "REQUESTER" ? "Active requests" : "Open errands";

  const content =
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
        {result.mode === "REQUESTER" && result.truncated && (
          <p style={{ fontSize: vars.text.sm, color: vars.color.textSubtle }}>
            Showing your 100 most recently updated active requests.
          </p>
        )}
      </>
    );

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
