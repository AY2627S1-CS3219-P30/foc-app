"use client";

import Link from "next/link";
import { use, useCallback, useState } from "react";
import { buttonClass } from "@/components/Button";
import { DesktopPanel } from "@/components/DesktopPanel";
import { NavRow } from "@/components/NavRow";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { formatWhen } from "@/lib/admin-labels";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { creditLabel } from "@/lib/credit-label";
import { getReceipt, type Receipt } from "@/lib/order-api";
import { usePoll } from "@/lib/use-poll";
import { vars } from "@/styles/tokens";

function ReceiptBody({ receipt, me }: { receipt: Receipt; me: string | undefined }) {
  const { supplier, timestamps: t } = receipt;
  const who = (id: string) => (id === me ? "You" : "Another student");
  return (
    <>
      <NavRow label="Supplier" value={`${supplier.name}, ${supplier.building}, floor ${supplier.floor}`} />
      <NavRow label="Reward" value={creditLabel(receipt.reward)} />
      <NavRow label="Requester" value={who(receipt.requesterId)} />
      <NavRow label="Courier" value={who(receipt.courierId)} />
      <NavRow label="Posted" value={formatWhen(t.createdAt)} />
      <NavRow label="Accepted" value={formatWhen(t.acceptedAt)} />
      <NavRow label="Picked up" value={formatWhen(t.pickedUpAt)} />
      <NavRow
        label="Delivered"
        value={t.deliveredAt ? formatWhen(t.deliveredAt) : "Not recorded: an administrator decided it for the courier"}
      />
      <NavRow label="Delivery accepted" value={formatWhen(t.completionRequestedAt)} />
      <NavRow label="Courier paid" value={formatWhen(t.completedAt)} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: vars.space[2], marginTop: vars.space[2] }}>
        <Link href={`/wallet?tx=${receipt.creditTransactionId}`} className={buttonClass()}>
          See it in your wallet
        </Link>
        <Link href={`/request/${receipt.orderId}`} className={buttonClass({ variant: "outline" })}>
          View errand
        </Link>
      </div>
    </>
  );
}

/** The completed errand's receipt. It never changes, so it is read once and again on returning. */
export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authed, user } = useAuth();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await authed((token) => getReceipt(token, id));
        if (signal.aborted) return null;
        setReceipt(next);
        setProblem(null);
      } catch (err) {
        if (signal.aborted) return null;
        setProblem(err instanceof ApiError ? err : new ApiError(0, "UNEXPECTED", "Something went wrong."));
      }
      return null;
    },
    [authed, id],
  );
  const reload = usePoll(read);

  const body = receipt ? (
    <ReceiptBody receipt={receipt} me={user?.id} />
  ) : problem?.status === 404 && problem.code === "RECEIPT_NOT_FOUND" ? (
    <EmptyState
      title="No receipt yet"
      action={
        <Link href={`/request/${id}`} className={buttonClass({ variant: "outline" })}>
          View errand
        </Link>
      }
    >
      An errand has a receipt once it is complete and the courier has been paid.
    </EmptyState>
  ) : problem?.status === 403 ? (
    <EmptyState title="Not your receipt">Only the errand&apos;s requester and courier can see its receipt.</EmptyState>
  ) : problem ? (
    <ErrorState title="Could not load this receipt" onRetry={reload}>
      {problem.message}
    </ErrorState>
  ) : (
    <LoadingState label="Loading the receipt…" rows={2} />
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <ScreenHeader title="Receipt" />
          <ScreenContent>{body}</ScreenContent>
        </Screen>
      </div>
      <div className="desktopOnly">
        <DesktopPanel title="Receipt">{body}</DesktopPanel>
      </div>
    </>
  );
}
