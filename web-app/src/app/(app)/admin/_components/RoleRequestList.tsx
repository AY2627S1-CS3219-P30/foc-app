"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { adminApi, type AdminUser, type RoleChangeRequest } from "@/lib/admin-api";
import { formatWhen, REQUEST_STATUSES, REQUEST_TONES } from "@/lib/admin-labels";
import { useAuth } from "@/lib/auth";
import { useDirectory } from "./Directory";
import { ReasonDialog, type PendingAction } from "./ReasonDialog";
import { useStepUp } from "./StepUp";
import { Tag, UserLink } from "./ui";
import styles from "./admin.module.css";

/**
 * Role-change requests and the decisions open to the admin viewing them (ADR 0008): a second
 * administrator approves or rejects; the requester may withdraw; the person concerned decides
 * nothing. The services enforce all of it — the buttons only follow the same rules.
 */
export function RoleRequestList({
  requests,
  me,
  onDecided,
}: {
  requests: RoleChangeRequest[];
  me: string | undefined;
  /**
   * After a decision, with what to tell the admin; an approval also passes the account as it now is.
   * Show the message outside this list: a decision can empty it.
   */
  onDecided: (outcome: { message: string; changed?: AdminUser }) => void;
}) {
  const { authed } = useAuth();
  const withStepUp = useStepUp();
  const { name, activeAdmins, reload: reloadDirectory } = useDirectory();
  const [action, setAction] = useState<PendingAction | null>(null);

  function decide(request: RoleChangeRequest, approve: boolean) {
    const target = name(request.targetUserId);
    const change =
      request.role === "ADMIN"
        ? `make ${target} an administrator`
        : `remove ${target}'s administrator role`;
    const done =
      request.role === "ADMIN"
        ? `${target} is now an administrator`
        : `${target} is no longer an administrator`;
    const withdraw = !approve && request.requestedBy === me;
    setAction({
      title: approve ? "Approve this role change?" : withdraw ? "Withdraw your request?" : "Reject this role change?",
      intro: approve ? (
        <p>
          This will {change} now, with you recorded as the approver. {name(request.requestedBy)}{" "}
          gave this reason: “{request.reason}”
        </p>
      ) : (
        <p>Nothing changes: the request to {change} closes.</p>
      ),
      confirmLabel: approve ? "Approve" : withdraw ? "Withdraw" : "Reject",
      run: async (reason) => {
        let changed: AdminUser | undefined;
        if (approve) {
          changed = await withStepUp(() => authed((t) => adminApi.approve(t, request.id, reason)));
        } else if (withdraw) {
          await authed((t) => adminApi.reject(t, request.id, reason));
        } else {
          // Refusing someone else's request needs the password, like approving it (ADR 0008).
          await withStepUp(() => authed((t) => adminApi.reject(t, request.id, reason)));
        }
        setAction(null);
        reloadDirectory();
        onDecided({
          message: approve
            ? `Approved: ${done}. The audit trail records you as the approver.`
            : withdraw
              ? "Withdrawn. Nothing changed."
              : "Rejected. Nothing changed.",
          changed,
        });
      },
    });
  }

  return (
    <>
      <ul className={styles.list}>
        {requests.map((r) => {
          const approvers = activeAdmins
            .filter((a) => a.id !== r.requestedBy && a.id !== r.targetUserId)
            .map((a) => (a.id === me ? `${a.email} (you)` : a.email));
          return (
            <li key={r.id} className={styles.item}>
              <div className={styles.tags}>
                <Tag tone={REQUEST_TONES[r.status]}>{REQUEST_STATUSES[r.status]}</Tag>
                <span className={styles.secondary}>asked {formatWhen(r.createdAt)}</span>
              </div>
              <p>
                <UserLink id={r.requestedBy} /> asked to{" "}
                {r.role === "ADMIN" ? "make " : "remove the administrator role from "}
                <UserLink id={r.targetUserId} />
                {r.role === "ADMIN" ? " an administrator." : "."}
              </p>
              <p className={styles.muted}>Reason: “{r.reason}”</p>
              {r.status === "PENDING" ? (
                <>
                  <p className={styles.muted}>
                    Can approve: {approvers.length ? approvers.join(", ") : "no other active administrator"}.
                    Expires {formatWhen(r.expiresAt)}.
                  </p>
                  <Decisions request={r} me={me} onDecide={decide} />
                </>
              ) : (
                r.decidedBy && (
                  <p className={styles.muted}>
                    {REQUEST_STATUSES[r.status]} by <UserLink id={r.decidedBy} />
                    {r.decidedAt && ` ${formatWhen(r.decidedAt)}`}
                    {r.decisionReason && `: “${r.decisionReason}”`}
                  </p>
                )
              )}
            </li>
          );
        })}
      </ul>
      <ReasonDialog action={action} onClose={() => setAction(null)} />
    </>
  );
}

function Decisions({
  request,
  me,
  onDecide,
}: {
  request: RoleChangeRequest;
  me: string | undefined;
  onDecide: (request: RoleChangeRequest, approve: boolean) => void;
}) {
  if (request.targetUserId === me) {
    return <p className={styles.muted}>This request is about you, so another administrator decides it.</p>;
  }
  if (request.requestedBy === me) {
    return (
      <div className={styles.actions}>
        <Button variant="outline" onClick={() => onDecide(request, false)}>
          Withdraw request
        </Button>
      </div>
    );
  }
  return (
    <div className={styles.actions}>
      <Button onClick={() => onDecide(request, true)}>Approve</Button>
      <Button variant="outline" onClick={() => onDecide(request, false)}>
        Reject
      </Button>
    </div>
  );
}
