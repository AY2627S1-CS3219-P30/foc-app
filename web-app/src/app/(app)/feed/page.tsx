"use client";

import { useCallback, useState } from "react";
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
import { useCredits } from "@/lib/credits";
import { STUDENT_NAV } from "@/lib/nav";
import { listOpenOrders, type OpenOrder } from "@/lib/order-api";
import { ORDER_ACTIONS } from "@/lib/order-actions";
import { useNowAfter } from "@/lib/use-now";
import { useOrderAction } from "@/lib/use-order-action";
import { usePoll } from "@/lib/use-poll";
import { useQueryParam } from "@/lib/use-query-param";

const FEED_POLL_MS = 30_000;
const MINUTE_MS = 60_000;
const WITHDRAWN = "You withdrew from the errand. Another courier can take it, unless its deadline has passed.";

/** `expiresAt` counts from the server's `timeRemainingSeconds`, so a wrong device clock can't skew it. */
type Listing = OpenOrder & { expiresAt: number };

/** Open errands; the Order Service already leaves out the student's own. */
function useFeed() {
  const { authed } = useAuth();
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const open = await authed(listOpenOrders);
        if (signal.aborted) return null;
        const readAt = Date.now();
        setListings(open.map((o) => ({ ...o, expiresAt: readAt + o.timeRemainingSeconds * 1000 })));
        setProblem(null);
      } catch (err) {
        if (signal.aborted) return null;
        setProblem(err instanceof ApiError ? err.message : "Something went wrong.");
      }
      return FEED_POLL_MS;
    },
    [authed],
  );
  const reload = usePoll(read);
  return { listings, problem, reload };
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
  const { listings, problem, reload } = useFeed();
  const withdrawn = useQueryParam("withdrawn") === "1";
  const [notice, setNotice] = useState<string | null>(null);
  const now = useNowAfter((time) => nextChange(listings, time));
  const { refresh: refreshCredits } = useCredits();
  const accept = useOrderAction({
    onDone: (order) => {
      refreshCredits();
      router.push(`/request/${order.orderId}`);
    },
    onStale: (message) => {
      setNotice(message);
      reload();
    },
  });

  const live = listings?.filter((l) => l.expiresAt > now) ?? [];
  const cards = live.map((l) => (
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

  const content =
    listings === null ? (
      problem ? (
        <ErrorState title="Could not load open errands" onRetry={reload}>
          {problem}
        </ErrorState>
      ) : (
        <LoadingState label="Loading open errands…" />
      )
    ) : (
      <>
        <FormAlert tone="info" takeFocus>{notice ?? (withdrawn && WITHDRAWN)}</FormAlert>
        {problem && <FormAlert>Could not refresh the list. {problem}</FormAlert>}
        {cards.length === 0 ? (
          <EmptyState title="No open errands right now">Check back soon.</EmptyState>
        ) : (
          <ErrandGrid>{cards}</ErrandGrid>
        )}
      </>
    );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <AppBar title="Feed" onPlusClick={() => router.push("/request/new")} />
          <ScreenContent>{content}</ScreenContent>
        </Screen>
      </div>

      <div className="desktopOnly">
        <DesktopShell
          navItems={STUDENT_NAV}
          activeHref="/feed"
          heading="Open errands"
          actions={<Button onClick={() => router.push("/request/new")}>New request</Button>}
        >
          {content}
        </DesktopShell>
      </div>

      <ActionDialog state={accept} />
    </>
  );
}
