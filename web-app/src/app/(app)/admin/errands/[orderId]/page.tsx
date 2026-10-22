"use client";

import Link from "next/link";
import { use, useState } from "react";
import { Button } from "@/components/Button";
import { FormAlert } from "@/components/FormField";
import { ErrorState, LoadingState } from "@/components/States";
import { adminApi, type AccountErrand, type DisputeOutcome } from "@/lib/admin-api";
import {
  DISPUTE_OUTCOMES,
  disputeCause,
  formatWhen,
  ORDER_STATUSES,
  ORDER_TONES,
} from "@/lib/admin-labels";
import { useAuth } from "@/lib/auth";
import { ReasonDialog, type PendingAction } from "../../_components/ReasonDialog";
import { AdminShell, Section, Tag, TraceLink, UserLink } from "../../_components/ui";
import { useAdminData } from "../../_components/use-admin-data";
import styles from "../../_components/admin.module.css";

export default function DisputePage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params);
  return <Dispute key={orderId} orderId={orderId} />;
}

const DECIDED: Record<DisputeOutcome, string> = {
  COURIER: "Decided for the courier. The reward is transferred once the Credit Service confirms.",
  REQUESTER:
    "Decided for the requester. The reward is returned, and the errand cancelled, once the Credit Service confirms.",
};

/**
 * ORD-11 (#271): one dispute, as the administrator it is referred to reads and decides it. The
 * private view (participants, delivery instructions, item notes) comes from the Order Service only
 * for that administrator; anyone else is refused there, and this page says so instead.
 */
function Dispute({ orderId }: { orderId: string }) {
  const { authed } = useAuth();
  const errand = useAdminData(`dispute:${orderId}`, (t) => adminApi.errand(t, orderId));
  const referrals = useAdminData("errands:disputes", (t) => adminApi.referredDisputes(t));
  const [latest, setLatest] = useState<AccountErrand | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<PendingAction | null>(null);

  const shown = latest ?? errand.data;
  const cause = referrals.data?.items.find((e) => e.orderId === orderId)?.referredBy;
  const notMine = errand.error?.status === 403;

  const decide = (outcome: DisputeOutcome) => {
    if (!shown) return;
    setAction({
      title: outcome === "COURIER" ? "Decide for the courier?" : "Decide for the requester?",
      intro: (
        <p>
          {DISPUTE_OUTCOMES[outcome]}. The decision can&apos;t be undone, and your reason is kept in
          the errand&apos;s history.
        </p>
      ),
      confirmLabel: outcome === "COURIER" ? "Decide for the courier" : "Decide for the requester",
      run: async (reason) => {
        const decided = await authed((t) =>
          adminApi.resolveDispute(t, orderId, { outcome, reason, expectedVersion: shown.version }),
        );
        setAction(null);
        setLatest(decided);
        setNotice(DECIDED[outcome]);
        referrals.reload();
      },
    });
  };

  return (
    <AdminShell
      active="/admin/errands"
      heading={shown ? `Dispute: ${shown.supplier.name}` : "Dispute"}
      actions={
        <Link href="/admin/errands" className={styles.link}>
          All errands needing attention
        </Link>
      }
    >
      <FormAlert tone="success">{notice}</FormAlert>
      {notMine ? (
        <Section title="Not referred to you">
          <p className={styles.muted}>
            This dispute is referred to another administrator, or to no one yet. Only the
            administrator it is referred to can read its private details (who took part, the
            delivery instructions, the item notes) and decide it.
          </p>
          <div className={styles.actions}>
            <TraceLink orderId={orderId} />
          </div>
        </Section>
      ) : errand.error ? (
        <ErrorState title="Couldn't open this errand" onRetry={errand.reload}>
          {errand.error.message}
        </ErrorState>
      ) : !shown ? (
        <LoadingState label="Opening the errand…" rows={2} />
      ) : (
        <>
          <Section title="Errand" description="Everything the Order Service records about it for you.">
            <dl className={styles.facts}>
              <dt>Status</dt>
              <dd>
                <Tag tone={ORDER_TONES[shown.status]}>{ORDER_STATUSES[shown.status]}</Tag>
              </dd>
              {cause && (
                <>
                  <dt>Why it was disputed</dt>
                  <dd>{disputeCause(cause)}</dd>
                </>
              )}
              <dt>Pickup</dt>
              <dd>
                {shown.supplier.name}, {shown.supplier.building} floor {shown.supplier.floor}
              </dd>
              <dt>Items</dt>
              <dd>
                <ul className={styles.plainList}>
                  {shown.items.map((item, i) => (
                    <li key={i}>
                      {item.quantity} × {item.name}
                      {item.note && <span className={styles.muted}> ({item.note})</span>}
                    </li>
                  ))}
                </ul>
              </dd>
              <dt>Delivery zone</dt>
              <dd>{shown.deliveryZone}</dd>
              <dt>Delivery instructions</dt>
              <dd>{shown.deliveryInstructions ?? "None given"}</dd>
              <dt>Requester</dt>
              <dd>
                <UserLink id={shown.requesterId ?? null} />
              </dd>
              <dt>Courier</dt>
              <dd>
                <UserLink id={shown.courierId ?? null} />
              </dd>
              <dt>Reward</dt>
              <dd>{shown.reward} credits</dd>
              <dt>Posted</dt>
              <dd>{formatWhen(shown.createdAt)}</dd>
              <dt>Last change</dt>
              <dd>{formatWhen(shown.updatedAt)}</dd>
            </dl>
            <div className={styles.actions}>
              <TraceLink orderId={orderId} />
              <span className={styles.muted}>opens its full history on the Operations tab</span>
            </div>
          </Section>

          <Section
            title="Decision"
            description="Read the history first: who reported what, and when. The decision is final."
          >
            {shown.status === "DISPUTED" ? (
              <div className={styles.actions}>
                <Button onClick={() => decide("COURIER")}>Decide for the courier</Button>
                <Button variant="outline" onClick={() => decide("REQUESTER")}>
                  Decide for the requester
                </Button>
              </div>
            ) : (
              <p className={styles.muted}>
                No longer in dispute: it is {ORDER_STATUSES[shown.status].toLowerCase()}.
              </p>
            )}
          </Section>
        </>
      )}
      <ReasonDialog action={action} onClose={() => setAction(null)} />
    </AdminShell>
  );
}
