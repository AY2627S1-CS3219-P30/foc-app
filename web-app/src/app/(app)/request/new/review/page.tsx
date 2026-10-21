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
  clearDraft,
  creditShortfall,
  itemsError,
  itemsLabel,
  keyReused,
  loadDraft,
  pickupLabel,
  projectedBalance,
  restartDraft,
  saveDraft,
  submitFailure,
  toCreateOrder,
  type Draft,
  type SubmitFailure,
} from "@/lib/composer";
import { useCredits } from "@/lib/credits";
import { STUDENT_NAV } from "@/lib/nav";
import { createOrder, getMyWallet, type CreateOrder, type Wallet } from "@/lib/order-api";
import type { Supplier } from "@/lib/supplier-api";
import { useSupplier } from "@/lib/use-supplier";
import styles from "../composer.module.css";

const credits = (n: number) => `${n} ${n === 1 ? "credit" : "credits"}`;

function Summary({
  userId,
  supplier,
  draft: stored,
}: {
  userId: string;
  supplier: Supplier;
  draft: Draft;
}) {
  const router = useRouter();
  const { authed } = useAuth();
  const { refresh: refreshCredits } = useCredits();
  const [draft, setDraft] = useState(stored);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletProblem, setWalletProblem] = useState("");
  const [walletRevision, setWalletRevision] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [alreadyPosted, setAlreadyPosted] = useState<string | null>(null);
  const inflight = useRef(false);
  const order = toCreateOrder(draft);
  const sentBody = draft.sentBody ?? order;
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

  const keep = (next: Draft) => {
    saveDraft(userId, next);
    setDraft(next);
  };

  async function submit() {
    if (inflight.current) return;
    inflight.current = true;
    setSubmitting(true);
    setFailure(null);
    keep({ ...draft, sentBody });
    const post = (body: CreateOrder) =>
      authed((token) => createOrder(token, body, draft.idempotencyKey));
    try {
      // A lost response can leave an earlier version under this key; replaying it finds that errand.
      const [created, replayed] = await post(order).then(
        (created) => [created, false] as const,
        async (err: unknown) => {
          if (!keyReused(err)) throw err;
          return [await post(sentBody), true] as const;
        },
      );
      refreshCredits();
      if (!replayed) {
        clearDraft(userId);
        router.replace(`/request/${created.orderId}`);
        return;
      }
      // These edits weren't applied, so they move to a new key to post as their own errand.
      keep(restartDraft(draft));
      setAlreadyPosted(created.orderId);
    } catch (err) {
      const next = submitFailure(err);
      // A refusal means this body wasn't stored, though one sent before it still may be.
      keep({
        ...draft,
        sentBody: next.kind === "retry" ? sentBody : draft.sentBody,
        ...(next.kind === "fields" && { errors: next.errors }),
      });
      setFailure(next);
    }
    inflight.current = false;
    setSubmitting(false);
  }

  const retryOnReconnect = useEffectEvent(() => void submit());
  useEffect(() => {
    if (failure?.kind !== "retry") return;
    window.addEventListener("online", retryOnReconnect);
    return () => window.removeEventListener("online", retryOnReconnect);
  }, [failure]);

  if (failure?.kind === "supplier")
    return <SupplierUnavailable onChooseAnother={() => router.push("/request/new")} />;

  if (alreadyPosted)
    return (
      <div className={styles.form}>
        <p role="alert" className={styles.notice}>
          This request was already posted before your latest changes, so they weren&apos;t applied.
        </p>
        <div className={styles.actions}>
          <Button
            variant="outline"
            onClick={() => {
              setAlreadyPosted(null);
              setWalletRevision((r) => r + 1);
            }}
          >
            Post these changes as a new request
          </Button>
          <Button onClick={() => router.replace(`/request/${alreadyPosted}`)}>View request</Button>
        </div>
      </div>
    );

  const shortfall = wallet ? creditShortfall(wallet.available, draft.reward) : undefined;
  const errors = failure?.kind === "fields" ? failure.errors : {};
  const fieldError = (message?: string) => message && <p className={styles.error}>{message}</p>;

  return (
    <div className={styles.form}>
      <NavRow label="Pickup" value={pickupLabel(supplier)} />
      {fieldError(errors.supplierId)}
      <NavRow label="Items" value={itemsLabel(order.items)} />
      {fieldError(itemsError(errors))}
      <NavRow label="Delivery zone" value={order.deliveryZone} />
      {fieldError(errors.deliveryZone)}
      <NavRow label="Delivery instructions" value={order.deliveryInstructions} />
      {fieldError(errors.deliveryInstructions)}
      <NavRow
        label="Open period"
        value="Open for a set time once your credits are reserved; the request shows the deadline"
      />
      <NavRow label="Reward" value={credits(order.reward)} />
      {fieldError(errors.reward)}
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
        {failure?.kind === "reused" ? (
          <Button
            onClick={() => {
              keep(restartDraft(draft));
              setFailure(null);
            }}
          >
            Start over
          </Button>
        ) : (
          // A sent body may already hold the reward, so a lower balance can't block finding it.
          <Button disabled={submitting || (!!shortfall && !draft.sentBody)} onClick={submit}>
            {submitting ? "Posting…" : failure?.kind === "retry" ? "Try again" : "Post request"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Mounted once the supplier has loaded, so the stored draft is only read in the browser. */
function ReviewStep({ userId, supplier }: { userId: string; supplier: Supplier }) {
  const router = useRouter();
  const [draft] = useState(() => loadDraft(userId));

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
  return <Summary userId={userId} supplier={supplier} draft={draft} />;
}

function Review() {
  const router = useRouter();
  const { user } = useAuth();
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
    user && <ReviewStep userId={user.id} supplier={lookup.supplier} />
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
