"use client";

import { useId, useState } from "react";
import { Button } from "@/components/Button";
import { adminApi, type AdminUser, type Role, type RoleChangeRequest } from "@/lib/admin-api";
import { useAuth } from "@/lib/auth";
import { useDirectory } from "../../_components/Directory";
import { ReasonDialog, type PendingAction } from "../../_components/ReasonDialog";
import { useStepUp } from "../../_components/StepUp";
import styles from "../../_components/admin.module.css";

/**
 * Suspend, reactivate, appoint and demote — each behind a reason, and the role changes and an admin's
 * suspension behind the password (ADR 0008). A button the services would refuse is disabled with the
 * rule that stops it; the services still decide.
 */
export function AccountActions({
  account,
  me,
  pending,
  onDone,
}: {
  account: AdminUser;
  me: string | undefined;
  pending: RoleChangeRequest | undefined;
  onDone: (message: string, changed?: AdminUser) => void;
}) {
  const { authed } = useAuth();
  const withStepUp = useStepUp();
  const { byId } = useDirectory();
  const [action, setAction] = useState<PendingAction | null>(null);
  const suspendNote = useId();
  const reactivateNote = useId();
  const roleNote = useId();

  const email = account.email;
  const self = account.id === me;
  const isAdmin = account.roles.includes("ADMIN");
  const seeded = me ? byId.get(me.toLowerCase())?.isSeededAdmin === true : false;

  const suspendBlocked = self
    ? "You can't suspend yourself."
    : isAdmin && !seeded
      ? "Only a bootstrap administrator can suspend an administrator."
      : undefined;
  const reactivateBlocked =
    isAdmin && !seeded ? "Only a bootstrap administrator can reactivate an administrator." : undefined;
  const roleBlocked = pending
    ? "A role change for this account is already waiting for approval."
    : isAdmin && self
      ? "You can't remove your own administrator role."
      : isAdmin && !seeded
        ? "Only a bootstrap administrator can remove an administrator."
        : !isAdmin && account.status !== "ACTIVE"
          ? "Only an active account can be made an administrator."
          : undefined;

  const suspend = () =>
    setAction({
      title: `Suspend ${email}?`,
      intro: (
        <>
          <p>
            They are signed out everywhere at once and can&apos;t sign in until an administrator
            reactivates them. Their errands, credits and history are kept.
          </p>
          {isAdmin && (
            <p>
              They are an administrator, so this needs your password and raises an alert the other
              administrators see.
            </p>
          )}
        </>
      ),
      confirmLabel: "Suspend account",
      run: async (reason) => {
        const user = await withStepUp(() => authed((t) => adminApi.suspend(t, account.id, reason)));
        setAction(null);
        onDone(`${email} is suspended. The audit record is below.`, user);
      },
    });

  const reactivate = () =>
    setAction({
      title: `Reactivate ${email}?`,
      intro: (
        <>
          <p>They can sign in and use the app again.</p>
          {isAdmin && (
            <p>
              They are an administrator, so this needs your password and raises an alert the other
              administrators see.
            </p>
          )}
        </>
      ),
      confirmLabel: "Reactivate account",
      run: async (reason) => {
        const user = await withStepUp(() =>
          authed((t) => adminApi.reactivate(t, account.id, reason)),
        );
        setAction(null);
        onDone(`${email} is active again. The audit record is below.`, user);
      },
    });

  const changeRole = (role: Role) =>
    setAction({
      title: role === "ADMIN" ? `Make ${email} an administrator?` : `Remove ${email}'s administrator role?`,
      intro: (
        <p>
          Another administrator must approve this before it takes effect, and you&apos;ll be asked
          for your password. Only if no other administrator could approve does it apply at once.
        </p>
      ),
      confirmLabel: role === "ADMIN" ? "Ask to appoint" : "Ask to remove",
      run: async (reason) => {
        const result = await withStepUp(() =>
          authed((t) => adminApi.changeRole(t, account.id, role, reason)),
        );
        setAction(null);
        if (result.kind === "pending") {
          onDone("Requested. Nothing changes until another administrator approves it.");
        } else {
          const now = result.user.roles.includes("ADMIN");
          onDone(
            `${email} ${now ? "is now" : "is no longer"} an administrator. No other administrator could approve, so it applied at once and raised an alert.`,
            result.user,
          );
        }
      },
    });

  return (
    <>
      <div className={styles.actions}>
        {account.status === "SUSPENDED" && (
          <Button
            disabled={!!reactivateBlocked}
            aria-describedby={reactivateBlocked ? reactivateNote : undefined}
            onClick={reactivate}
          >
            Reactivate
          </Button>
        )}
        {account.status === "ACTIVE" && (
          <Button
            variant="outline"
            disabled={!!suspendBlocked}
            aria-describedby={suspendBlocked ? suspendNote : undefined}
            onClick={suspend}
          >
            Suspend
          </Button>
        )}
        <Button
          variant="outline"
          disabled={!!roleBlocked}
          aria-describedby={roleBlocked ? roleNote : undefined}
          onClick={() => changeRole(isAdmin ? "STUDENT" : "ADMIN")}
        >
          {isAdmin ? "Remove administrator role" : "Make administrator"}
        </Button>
      </div>
      {account.status === "PENDING_ACTIVATION" && (
        <p className={styles.muted}>
          This account isn&apos;t activated yet, so it can&apos;t be suspended or made an
          administrator.
        </p>
      )}
      {reactivateBlocked && account.status === "SUSPENDED" && (
        <p id={reactivateNote} className={styles.muted}>
          {reactivateBlocked}
        </p>
      )}
      {suspendBlocked && account.status === "ACTIVE" && (
        <p id={suspendNote} className={styles.muted}>
          {suspendBlocked}
        </p>
      )}
      {roleBlocked && (
        <p id={roleNote} className={styles.muted}>
          {roleBlocked}
        </p>
      )}
      <ReasonDialog action={action} onClose={() => setAction(null)} />
    </>
  );
}
