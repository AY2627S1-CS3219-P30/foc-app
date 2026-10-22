"use client";

import Link from "next/link";
import { use, useState } from "react";
import { Button } from "@/components/Button";
import { FormAlert } from "@/components/FormField";
import { ErrorState, LoadingState } from "@/components/States";
import { adminApi, type AccountErrand, type DisputeOutcome } from "@/lib/admin-api";
import { ApiError } from "@/lib/api-client";
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
 * for that administrator and the errand's own participants; anyone else is refused there, and this
 * page says so instead.
 */
function Dispute({ orderId }: { orderId: string }) {
  const { authed, user: me } = useAuth();
  const errand = useAdminData(`dispute:${orderId}`, (t) => adminApi.errand(t, orderId));
  const referrals = useAdminData("errands:disputes", (t) => adminApi.referredDisputes(t));
  const [latest, setLatest] = useState<AccountErrand | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [action, setAction] = useState<PendingAction | null>(null);

  const shown = latest ?? errand.data;
  const cause = referrals.data?.items.find((e) => e.orderId === orderId)?.referredBy;
  const notMine = errand.error?.status === 403;
  // A participant who is also an administrator reads it as a participant, but may not decide it.
  const tookPart = !!me && (shown?.requesterId === me.id || shown?.courierId === me.id);

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
        let decided: AccountErrand;
        try {
          decided = await authed((t) =>
            adminApi.resolveDispute(t, orderId, { outcome, reason, expectedVersion: shown.version }),
          );
        } catch (err) {
          // Decided in another tab, or referred to someone else since this page was read: show where
          // it stands now instead of retrying against the version on screen.
          if (err instanceof ApiError && (err.status === 409 || err.code === "NOT_REFERRED_ADMIN")) {
            setAction(null);
            setLatest(null);
            setNotice(null);
            setChanged(
              "This dispute changed since you opened it, so your decision was not recorded. This is where it stands now.",
            );
            errand.reload();
            return;
          }
          throw err;
        }
        setAction(null);
        setLatest(decided);
        setChanged(null);
        setNotice(DECIDED[outcome]);
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
      <FormAlert tone="info">{changed}</FormAlert>
      {notMine ? (
        <Section title="You can't read this errand's private details">
          <p className={styles.muted}>
            Only its requester, its courier and, for a dispute, the administrator it is referred to
            can read who took part, the delivery instructions and the item notes. If this is a
            dispute, it is referred to another administrator or to no one yet.
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
              <dd>{shown.deliveryInstructions}</dd>
              <dt>Requester</dt>
              <dd>
                <UserLink id={shown.requesterId ?? null} />
              </dd>
              <dt>Courier</dt>
              <dd>
                <UserLink id={shown.courierId ?? null} />
              </dd>
              <dt>Reward</dt>
              <dd>{shown.reward}</dd>
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
            {shown.status === "DISPUTED" && tookPart ? (
              <p className={styles.muted}>
                You took part in this errand, so you can&apos;t decide it: the Order Service refuses a
                conflict of interest. It goes to an administrator who didn&apos;t.
              </p>
            ) : shown.status === "DISPUTED" ? (
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
