"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { FormAlert } from "@/components/FormField";
import { Input } from "@/components/Input";
import { EmptyState, LoadingState } from "@/components/States";
import { adminApi, type LedgerItem } from "@/lib/admin-api";
import { ApiError } from "@/lib/api-client";
import { formatWhen, isUuid, shortId } from "@/lib/admin-labels";
import { useAuth } from "@/lib/auth";
import { useQueryParam } from "@/lib/use-query-param";
import { AdminShell, Loaded, Section, UserLink } from "../_components/ui";
import { useAccountInput } from "../_components/use-account-input";
import { useAdminData } from "../_components/use-admin-data";
import styles from "../_components/admin.module.css";

const LEDGER_TYPES: Record<LedgerItem["type"], string> = {
  ISSUE: "Starting credits",
  RESERVE: "Reserved for an errand",
  RELEASE: "Released back",
  TRANSFER: "Transferred",
};

export default function WalletsPage() {
  const user = useQueryParam("user");
  return (
    <AdminShell active="/admin/wallets" heading="Wallets">
      {user === undefined ? <LoadingState label="Loading…" rows={1} /> : <Lookup initial={user ?? ""} />}
    </AdminShell>
  );
}

function Lookup({ initial }: { initial: string }) {
  const account = useAccountInput(initial);
  const [userId, setUserId] = useState<string | null>(isUuid(initial) ? initial.toLowerCase() : null);

  function look(e: FormEvent) {
    e.preventDefault();
    const id = account.resolve();
    if (id) setUserId(id);
  }

  return (
    <>
      <Section
        title="Look up a wallet"
        description="Read-only: no administrator can add, remove or move credits. The Credit Service records every look, with your name."
      >
        <form className={styles.filters} onSubmit={look} role="search" aria-label="Find a wallet">
          <Field label="Account (email or id)" error={account.error}>
            <Input value={account.text} onChange={(e) => account.setText(e.target.value)} />
          </Field>
          <Button type="submit">Look up</Button>
        </form>
      </Section>
      {userId && <WalletView key={userId} userId={userId} />}
    </>
  );
}

function WalletView({ userId }: { userId: string }) {
  const { authed } = useAuth();
  const wallet = useAdminData(`wallet:${userId}`, (t) => adminApi.wallet(t, userId));
  const first = useAdminData(`ledger:${userId}`, (t) => adminApi.ledger(t, userId));
  const [more, setMore] = useState<{ items: LedgerItem[]; cursor: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (wallet.error?.status === 404) {
    return (
      <Section title="Wallet">
        <EmptyState title="No wallet yet">
          <UserLink id={userId} /> has no wallet: one is issued when an account is activated.
        </EmptyState>
      </Section>
    );
  }

  const cursor = more ? more.cursor : (first.data?.nextCursor ?? null);
  async function loadMore() {
    if (!cursor) return;
    setBusy(true);
    setProblem(null);
    try {
      const page = await authed((t) => adminApi.ledger(t, userId, cursor));
      setMore((m) => ({ items: [...(m?.items ?? []), ...page.items], cursor: page.nextCursor }));
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Couldn't load more. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section title="Wallet" description={<>Belongs to <UserLink id={userId} />.</>}>
        <Loaded state={wallet} label="the wallet">
          {(w) => (
            <>
              <div className={styles.stats}>
                <Figure label="Available" value={w.available} />
                <Figure label="Reserved for errands" value={w.reserved} />
                <Figure label="Total" value={w.total} />
              </div>
              <p className={styles.muted}>Last changed {formatWhen(w.updatedAt)}.</p>
            </>
          )}
        </Loaded>
      </Section>

      <Section title="Ledger" description="Every movement of credits, newest first. Entries are never edited or removed.">
        <Loaded
          state={first}
          label="the ledger"
          isEmpty={(d) => d.items.length === 0}
          emptyTitle="No entries"
          emptyText="Credits have not moved in this wallet yet."
        >
          {(d) => (
            <>
              <LedgerTable items={[...d.items, ...(more?.items ?? [])]} />
              <FormAlert>{problem}</FormAlert>
              {cursor && (
                <Button variant="outline" onClick={loadMore} disabled={busy}>
                  {busy ? "Loading…" : "Load more"}
                </Button>
              )}
            </>
          )}
        </Loaded>
      </Section>
    </>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className={`card ${styles.stat}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

function LedgerTable({ items }: { items: LedgerItem[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="srOnly">Ledger entries, newest first</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Entry</th>
            <th scope="col" className={styles.number}>
              Credits
            </th>
            <th scope="col">Errand</th>
            <th scope="col" className={styles.number}>
              Available after
            </th>
            <th scope="col" className={styles.number}>
              Reserved after
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.transactionId}>
              <td className={styles.nowrap}>{formatWhen(e.occurredAt)}</td>
              <td>{LEDGER_TYPES[e.type]}</td>
              <td className={styles.number}>{e.amount}</td>
              <td className={styles.mono}>{e.orderId ? shortId(e.orderId) : "—"}</td>
              <td className={styles.number}>{e.resultingAvailable}</td>
              <td className={styles.number}>{e.resultingReserved}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
