"use client";

import type { AuditRecord } from "@/lib/admin-api";
import { AUDIT_ACTIONS, AUDIT_TONES, formatWhen } from "@/lib/admin-labels";
import { cx } from "@/lib/cx";
import { Tag, UserLink } from "./ui";
import styles from "./admin.module.css";

/** How a role change was approved (ADR 0008). */
const APPROVALS: Record<NonNullable<AuditRecord["approval"]>, string> = {
  SECOND_ADMIN: "Approved by a second administrator",
  NO_APPROVER: "Alone: nobody else held the role",
};

/**
 * Audit records, newest first. Records not in `known` are marked new: the record an action just
 * wrote appears, marked, without a reload.
 */
export function AuditTable({
  records,
  known,
  showTarget = true,
}: {
  records: AuditRecord[];
  known?: ReadonlySet<string> | null;
  showTarget?: boolean;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="srOnly">Audit records, newest first</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What</th>
            {showTarget && <th scope="col">Account</th>}
            <th scope="col">By</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => {
            const fresh = known ? !known.has(r.id) : false;
            return (
              <tr key={r.id} className={cx(fresh && styles.fresh)}>
                <td className={styles.nowrap}>
                  {formatWhen(r.occurredAt)}
                  {fresh && <span className={styles.secondary}>Just recorded</span>}
                </td>
                <td>
                  <Tag tone={AUDIT_TONES[r.action]}>{AUDIT_ACTIONS[r.action]}</Tag>
                  {r.approval && <span className={styles.secondary}>{APPROVALS[r.approval]}</span>}
                </td>
                {showTarget && (
                  <td>
                    <UserLink id={r.targetUserId} />
                  </td>
                )}
                <td>{r.actorType === "SYSTEM" ? "System (deployment)" : <UserLink id={r.actorId} />}</td>
                <td>{r.reason}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
