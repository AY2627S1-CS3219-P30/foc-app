"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { FormAlert } from "@/components/FormField";
import { LedgerRow, ledgerAnchor } from "@/components/LedgerRow";
import { ResponsiveShell } from "@/components/ResponsiveShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { WalletBalance } from "@/components/WalletBalance";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { useCredits } from "@/lib/credits";
import { STUDENT_NAV } from "@/lib/nav";
import { listMyLedger, type LedgerItem } from "@/lib/order-api";
import { usePoll } from "@/lib/use-poll";
import { useQueryParam } from "@/lib/use-query-param";
import { vars } from "@/styles/tokens";

type Ledger = { items: LedgerItem[]; nextCursor: string | null };

const column = { display: "flex", flexDirection: "column", gap: vars.space[3] } as const;

const holds = (ledger: Ledger, transactionId: string) => ledger.items.some((i) => i.transactionId === transactionId);

function merge(old: Ledger | null, fresh: Ledger): Ledger {
  if (!old) return fresh;
  const known = new Set(old.items.map((i) => i.transactionId));
  if (!fresh.items.some((i) => known.has(i.transactionId))) return fresh;
  const newer = fresh.items.filter((i) => !known.has(i.transactionId));
  return { items: [...newer, ...old.items], nextCursor: old.nextCursor };
}

/**
 * The student's wallet and ledger. `?tx=` (a receipt's credit transaction) loads pages until that
 * entry is on screen, then focuses it.
 */
export default function WalletPage() {
  const { authed } = useAuth();
  const { wallet, problem: walletProblem, refresh: refreshWallet } = useCredits();
  const target = useQueryParam("tx");
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [ledgerProblem, setLedgerProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moreProblem, setMoreProblem] = useState<string | null>(null);
  const ledgerRef = useRef<Ledger | null>(null);
  const walkedTarget = useRef<string | null>(null);

  useEffect(() => {
    ledgerRef.current = ledger;
  }, [ledger]);

  const read = useCallback(
    async (signal: AbortSignal) => {
      if (target === undefined) return null;
      try {
        const first = await authed((t) => listMyLedger(t));
        let fresh: Ledger = first;
        const current = ledgerRef.current;
        const refreshed = merge(current, first);
        const walk =
          !!target &&
          !holds(refreshed, target) &&
          (walkedTarget.current !== target || (!!current && holds(current, target)));
        while (walk && fresh.nextCursor && !holds(fresh, target) && !signal.aborted) {
          const cursor = fresh.nextCursor;
          const page = await authed((t) => listMyLedger(t, cursor));
          fresh = { items: [...fresh.items, ...page.items], nextCursor: page.nextCursor };
        }
        if (signal.aborted) return null;
        if (walk) walkedTarget.current = target;
        setLedger((old) => (walk ? fresh : merge(old, fresh)));
        setLedgerProblem(null);
      } catch (err) {
        if (!signal.aborted) setLedgerProblem(err instanceof ApiError ? err.message : "Something went wrong.");
      }
      return 30_000;
    },
    [authed, target],
  );
  const reload = usePoll(read);

  function retry() {
    refreshWallet();
    reload();
  }

  async function loadMore() {
    const cursor = ledger?.nextCursor;
    if (!cursor) return;
    setBusy(true);
    setMoreProblem(null);
    try {
      const page = await authed((t) => listMyLedger(t, cursor));
      setLedger((l) =>
        l?.nextCursor === cursor ? { items: [...l.items, ...page.items], nextCursor: page.nextCursor } : l,
      );
    } catch (err) {
      setMoreProblem(err instanceof ApiError ? err.message : "Couldn't load more. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const found = !!target && !!ledger && holds(ledger, target);
  useEffect(() => {
    if (found && target) document.getElementById(ledgerAnchor(target))?.focus();
  }, [found, target]);

  const missingWallet = walletProblem?.code === "WALLET_NOT_FOUND";
  const refreshProblem = walletProblem?.message ?? ledgerProblem;
  const content = missingWallet ? (
    <EmptyState
      title="Your wallet is being set up"
      action={
        <Button variant="outline" onClick={retry}>
          Check again
        </Button>
      }
    >
      Credits are issued after your account is activated. Check again shortly.
    </EmptyState>
  ) : !wallet || !ledger ? (
    refreshProblem ? (
      <ErrorState title="Could not load your wallet" onRetry={retry}>
        {refreshProblem}
      </ErrorState>
    ) : (
      <LoadingState label="Loading your wallet…" rows={2} />
    )
  ) : (
    <>
      <FormAlert>
        {refreshProblem
          ? `Couldn't refresh your wallet. The figures below may be out of date. ${refreshProblem}`
          : null}
      </FormAlert>
      {refreshProblem && (
        <Button variant="outline" onClick={retry}>
          Try again
        </Button>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: vars.space[5], alignItems: "flex-start" }}>
        <div style={{ ...column, flex: "1 1 280px", maxWidth: 400 }}>
          <WalletBalance wallet={wallet} />
          {wallet.available === 0 && (
            <p style={{ fontSize: vars.text.sm, color: vars.color.textMuted }}>
              With no credits available you can&apos;t post a request, but you can still earn credits as a courier.{" "}
              <Link href="/feed" style={{ color: vars.color.primary, textDecoration: "underline" }}>
                Find errands to deliver
              </Link>
              .
            </p>
          )}
        </div>
        <section style={{ ...column, flex: "1 1 320px", maxWidth: 520 }}>
          <h2 style={{ fontSize: vars.text.lg, fontWeight: vars.weight.semibold }}>Activity</h2>
          {target && !found && !ledger.nextCursor && (
            <FormAlert tone="info">That entry isn&apos;t in your wallet&apos;s activity.</FormAlert>
          )}
          {ledger.items.length === 0 ? (
            <EmptyState title="No activity yet">Credits haven&apos;t moved in your wallet yet.</EmptyState>
          ) : (
            <div className="card" style={{ padding: `0 ${vars.space[4]}` }}>
              {ledger.items.map((entry) => (
                <LedgerRow key={entry.transactionId} entry={entry} current={entry.transactionId === target} />
              ))}
            </div>
          )}
          <FormAlert>{moreProblem}</FormAlert>
          {ledger.nextCursor && (
            <Button variant="outline" onClick={loadMore} disabled={busy}>
              {busy ? "Loading…" : "Load more"}
            </Button>
          )}
        </section>
      </div>
    </>
  );

  return (
    <ResponsiveShell title="Wallet" navItems={STUDENT_NAV} activeHref="/wallet">
      {content}
    </ResponsiveShell>
  );
}
