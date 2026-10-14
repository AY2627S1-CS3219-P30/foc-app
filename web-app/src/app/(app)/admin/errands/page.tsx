"use client";

import { Button } from "@/components/Button";
import { adminApi } from "@/lib/admin-api";
import {
  formatDuration,
  formatWhen,
  RECONCILIATION_ACTIONS,
  shortId,
} from "@/lib/admin-labels";
import { AdminShell, Loaded, Section, Tag, UserLink } from "../_components/ui";
import { useAdminData } from "../_components/use-admin-data";
import styles from "../_components/admin.module.css";

export default function ErrandsPage() {
  const waits = useAdminData("errands:waits", (t) => adminApi.creditWaits(t));
  const attempts = useAdminData("errands:reconciliation", (t) => adminApi.reconciliation(t));

  return (
    <AdminShell active="/admin/errands" heading="Errands needing attention">
      <Section
        title="Waiting on credits too long"
        description="Errands still waiting for the Credit Service to reserve the reward after the limit (5 minutes by default), oldest first. Listing one does not reject it: it still opens if the reservation arrives."
        actions={
          <Button variant="outline" onClick={waits.reload}>
            Refresh
          </Button>
        }
      >
        <Loaded
          state={waits}
          label="waiting errands"
          isEmpty={(d) => d.items.length === 0}
          emptyTitle="Nothing is stuck"
          emptyText="Every errand has its credits, or is still within the limit."
        >
          {(d) => (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="srOnly">Errands waiting on credits, oldest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Errand</th>
                    <th scope="col">Requester</th>
                    <th scope="col" className={styles.number}>
                      Reward
                    </th>
                    <th scope="col">Created</th>
                    <th scope="col">Waiting</th>
                    <th scope="col">Operator alert</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((w) => (
                    <tr key={w.orderId}>
                      <td className={styles.mono}>{shortId(w.orderId)}</td>
                      <td>
                        <UserLink id={w.requesterId} />
                      </td>
                      <td className={styles.number}>{w.reward}</td>
                      <td className={styles.nowrap}>{formatWhen(w.createdAt)}</td>
                      <td className={styles.nowrap}>{formatDuration(w.waitingMs)}</td>
                      <td className={styles.nowrap}>
                        {w.alertRaisedAt ? formatWhen(w.alertRaisedAt) : "Not yet"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loaded>
      </Section>

      <Section
        title="Credit reconciliation"
        description="The latest decisions of the job that compares what the Order and Credit services each hold for an errand. “Contradiction raised” needs a person."
        actions={
          <Button variant="outline" onClick={attempts.reload}>
            Refresh
          </Button>
        }
      >
        <Loaded
          state={attempts}
          label="reconciliation attempts"
          isEmpty={(d) => d.items.length === 0}
          emptyTitle="Nothing to reconcile"
          emptyText="The Order and Credit services agree about every errand they have checked."
        >
          {(d) => (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="srOnly">Reconciliation attempts, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Errand</th>
                    <th scope="col">Order says</th>
                    <th scope="col">Credit says</th>
                    <th scope="col">What the job did</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((a) => (
                    <tr key={a.attemptId}>
                      <td className={styles.nowrap}>{formatWhen(a.attemptedAt)}</td>
                      <td className={styles.mono}>{shortId(a.orderId)}</td>
                      <td>{a.orderStatus}</td>
                      <td>
                        {a.creditStatus ?? "Unknown"}
                        {a.creditDetail && <span className={styles.secondary}>{a.creditDetail}</span>}
                      </td>
                      <td>
                        <Tag tone={a.action === "ALERTED" ? "danger" : a.action === "REISSUED" ? "info" : "warning"}>
                          {RECONCILIATION_ACTIONS[a.action]}
                        </Tag>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loaded>
      </Section>

      <Section
        title="Referred to an administrator"
        description="Disputed errands that the Order Service hands to an administrator to decide."
      >
        <p className={styles.muted}>
          Arrives with ORD-11 (#171): referred errands will be listed here to decide, with a reason,
          by an administrator who is neither the requester nor the courier.
        </p>
      </Section>
    </AdminShell>
  );
}
