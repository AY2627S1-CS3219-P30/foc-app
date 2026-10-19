"use client";

import { Suspense, useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/Button";
import { NavRow } from "@/components/NavRow";
import { ResponsiveShell } from "@/components/ResponsiveShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { SupplierUnavailable } from "@/components/SupplierPicker";
import { useAuth } from "@/lib/auth";
import {
  OPEN_PERIOD_MINUTES,
  clearDraft,
  creditShortfall,
  itemsLabel,
  loadDraft,
  pickupLabel,
  projectedBalance,
  submitFailure,
  toCreateOrder,
  type Draft,
  type DraftField,
  type SubmitFailure,
} from "@/lib/composer";
import { STUDENT_NAV } from "@/lib/nav";
import { createOrder, getMyWallet, type Wallet } from "@/lib/order-api";
import type { Supplier } from "@/lib/supplier-api";
import { useSupplier } from "@/lib/use-supplier";
import styles from "../composer.module.css";

const credits = (n: number) => `${n} ${n === 1 ? "credit" : "credits"}`;

function Summary({ supplier, draft }: { supplier: Supplier; draft: Draft }) {
  const router = useRouter();
  const { authed } = useAuth();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletProblem, setWalletProblem] = useState("");
  const [walletRevision, setWalletRevision] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const inflight = useRef(false);
  const order = toCreateOrder(draft);
  const detailsHref = `/request/new/details?supplierId=${supplier.supplierId}`;

  useEffect(() => {
    let live = true;
    authed(getMyWallet).then(
      (found) => live && setWallet(found),
      (cause: Error) => live && setWalletProblem(cause.message),
    );
    return () => {
      live = false;
    };
  }, [authed, walletRevision]);

  async function submit() {
    if (inflight.current) return;
    inflight.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const created = await authed((token) => createOrder(token, order, draft.idempotencyKey));
      clearDraft();
      router.replace(`/request/${created.orderId}`);
    } catch (err) {
      const next = submitFailure(err);
      if (next.kind === "resent") clearDraft();
      setFailure(next);
      inflight.current = false;
      setSubmitting(false);
    }
  }

  const retryOnReconnect = useEffectEvent(() => void submit());
  useEffect(() => {
    if (failure?.kind !== "retry") return;
    window.addEventListener("online", retryOnReconnect);
    return () => window.removeEventListener("online", retryOnReconnect);
  }, [failure]);

  if (failure?.kind === "supplier")
    return <SupplierUnavailable onChooseAnother={() => router.push("/request/new")} />;

  const shortfall = wallet ? creditShortfall(wallet.available, draft.reward) : undefined;
  const fieldError = (field: DraftField) => {
    const message = failure?.kind === "fields" ? failure.errors[field] : undefined;
    return message && <p className={styles.error}>{message}</p>;
  };

  return (
    <div className={styles.form}>
      <NavRow label="Pickup" value={pickupLabel(supplier)} />
      {fieldError("supplierId")}
      <NavRow label="Items" value={itemsLabel(order.items)} />
      {fieldError("items")}
      <NavRow label="Delivery zone" value={order.deliveryZone} />
      {fieldError("deliveryZone")}
      <NavRow label="Delivery instructions" value={order.deliveryInstructions} />
      {fieldError("deliveryInstructions")}
      <NavRow
        label="Open period"
        value={`Open for ${OPEN_PERIOD_MINUTES} minutes once your credits are reserved`}
      />
      <NavRow label="Reward" value={credits(order.reward)} />
      {fieldError("reward")}
      {wallet ? (
        <>
          <NavRow label="Available balance" value={credits(wallet.available)} />
          {shortfall ? (
            <p className={`card ${styles.blocked}`}>{shortfall}</p>
          ) : (
            <NavRow
              label="Available after reserving the reward"
              value={credits(projectedBalance(wallet.available, order.reward))}
            />
          )}
        </>
      ) : walletProblem ? (
        <ErrorState
          title="Could not load your balance"
          onRetry={() => {
            setWalletProblem("");
            setWalletRevision((r) => r + 1);
          }}
        >
          {walletProblem}
        </ErrorState>
      ) : (
        <LoadingState label="Loading your balance…" rows={1} />
      )}
      {failure && (
        <p role="alert" className={styles.error}>
          {failure.kind === "fields"
            ? "Some details need changing. Edit them, then review again."
            : failure.message}
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="outline" disabled={submitting} onClick={() => router.push(detailsHref)}>
          Edit details
        </Button>
        <Button
          disabled={!wallet || !!shortfall || submitting || failure?.kind === "resent"}
          onClick={submit}
        >
          {submitting ? "Posting…" : failure?.kind === "retry" ? "Try again" : "Post request"}
        </Button>
      </div>
    </div>
  );
}

/** Mounted once the supplier has loaded, so the stored draft is only read in the browser. */
function ReviewStep({ supplier }: { supplier: Supplier }) {
  const router = useRouter();
  const [draft] = useState(loadDraft);

  if (draft?.supplierId !== supplier.supplierId)
    return (
      <EmptyState
        title="Nothing to review yet"
        action={
          <Button
            onClick={() => router.replace(`/request/new/details?supplierId=${supplier.supplierId}`)}
          >
            Add the details
          </Button>
        }
      />
    );
  return <Summary supplier={supplier} draft={draft} />;
}

function Review() {
  const router = useRouter();
  const [lookup, retry] = useSupplier(useSearchParams().get("supplierId"));

  return lookup.status === "loading" ? (
    <LoadingState label="Loading your request…" rows={1} />
  ) : lookup.status === "unavailable" ? (
    <SupplierUnavailable onChooseAnother={() => router.push("/request/new")} />
  ) : lookup.status === "error" ? (
    <ErrorState title="Could not load the pickup point" onRetry={retry}>
      {lookup.message}
    </ErrorState>
  ) : (
    <ReviewStep supplier={lookup.supplier} />
  );
}

export default function NewRequestReviewPage() {
  return (
    <ResponsiveShell title="Review request" navItems={STUDENT_NAV} activeHref="/feed">
      <Suspense fallback={null}>
        <Review />
      </Suspense>
    </ResponsiveShell>
  );
}
