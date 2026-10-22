"use client";

import Link from "next/link";
import { Button } from "@/components/Button";
import { adminApi } from "@/lib/admin-api";
import { DISPUTE_OUTCOMES, disputeCause, formatWhen, shortId } from "@/lib/admin-labels";
import { Loaded, Section, Stat, Tag, TraceLink, UserLink } from "../_components/ui";
import { figure, useAdminData } from "../_components/use-admin-data";
import styles from "../_components/admin.module.css";

/**
 * ADM-06 (#279): how many errands are disputed right now, whoever they are referred to. One count
 * from the Order Service; a dash when it does not answer.
 */
export function DisputesWaitingStat() {
  const disputed = useAdminData("overview:disputed", (t) =>
    adminApi.errands(t, { status: ["DISPUTED"], pageSize: 1 }),
  );
  return <Stat href="/admin/errands" label="Disputes waiting" value={figure(disputed, (d) => d.total)} />;
}

/**
 * ORD-11 (#271): disputes referred to this administrator, which they open and decide, and disputes
 * referred to no one yet. The Order Service decides who sees what: only the caller's own referrals
 * carry private details, and disputes referred to another administrator are not listed at all.
 */
export function Disputes() {
  const disputes = useAdminData("errands:disputes", (t) => adminApi.referredDisputes(t));

  return (
    <Section
      title="Disputes"
      description="Disputes referred to you, which you open and decide, and those not yet referred to anyone. Each goes to an administrator who was neither its requester nor its courier. Oldest first."
      actions={
        <Button variant="outline" onClick={disputes.reload}>
          Refresh
        </Button>
      }
    >
      <Loaded
        state={disputes}
        label="disputes"
        isEmpty={(d) => d.items.length === 0}
        emptyTitle="No disputes"
        emptyText="Nothing is referred to you, and every dispute has an administrator."
      >
        {(d) => (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="srOnly">Disputes, oldest first</caption>
              <thead>
                <tr>
                  <th scope="col">Errand</th>
                  <th scope="col">Why it was disputed</th>
                  <th scope="col">Supplier</th>
                  <th scope="col" className={styles.number}>
                    Reward
                  </th>
                  <th scope="col">Last change</th>
                  <th scope="col">Referred to</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((e) => (
                  <tr key={e.orderId}>
                    <td>
                      {e.assignedToMe ? (
                        <Link href={`/admin/errands/${e.orderId}`} className={styles.link} title="Open and decide">
                          {shortId(e.orderId)}
                        </Link>
                      ) : (
                        <TraceLink orderId={e.orderId} />
                      )}
                    </td>
                    <td>{disputeCause(e.referredBy)}</td>
                    <td>{e.supplier.name}</td>
                    <td className={styles.number}>{e.reward}</td>
                    <td className={styles.nowrap}>{formatWhen(e.updatedAt)}</td>
                    <td>
                      {e.assignedToMe ? <Tag tone="info">You</Tag> : <Tag tone="warning">No one yet</Tag>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Loaded>
    </Section>
  );
}

/** The latest decisions, newest first: who decided, which way and why. */
export function RecentDecisions() {
  const decisions = useAdminData("errands:decisions", (t) => adminApi.disputeDecisions(t));

  return (
    <Section
      title="Recent decisions"
      description="The latest dispute decisions, newest first. Each reason is also kept in the errand's history."
      actions={
        <Button variant="outline" onClick={decisions.reload}>
          Refresh
        </Button>
      }
    >
      <Loaded
        state={decisions}
        label="decisions"
        isEmpty={(d) => d.items.length === 0}
        emptyTitle="No decisions yet"
        emptyText="Decided disputes appear here."
      >
        {(d) => (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="srOnly">Dispute decisions, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Errand</th>
                  <th scope="col">Decided by</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((x) => (
                  <tr key={`${x.orderId}-${x.decidedAt}`}>
                    <td className={styles.nowrap}>{formatWhen(x.decidedAt)}</td>
                    <td>
                      <TraceLink orderId={x.orderId} />
                    </td>
                    <td>
                      <UserLink id={x.adminId} />
                    </td>
                    <td>{DISPUTE_OUTCOMES[x.outcome]}</td>
                    <td>{x.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Loaded>
    </Section>
  );
}
