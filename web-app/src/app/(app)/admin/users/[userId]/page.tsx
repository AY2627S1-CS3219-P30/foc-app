"use client";

import Link from "next/link";
import { use, useState } from "react";
import { FormAlert } from "@/components/FormField";
import { ErrorState, LoadingState } from "@/components/States";
import { adminApi, type AdminUser } from "@/lib/admin-api";
import { ACCOUNT_STATUSES, formatWhen, STATUS_TONES } from "@/lib/admin-labels";
import { useAuth } from "@/lib/auth";
import { AuditTable } from "../../_components/AuditTable";
import { useDirectory } from "../../_components/Directory";
import { RoleRequestList } from "../../_components/RoleRequestList";
import { AdminShell, Loaded, Section, Tag } from "../../_components/ui";
import { useAdminData } from "../../_components/use-admin-data";
import styles from "../../_components/admin.module.css";
import { AccountActions } from "./AccountActions";

export default function AccountPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  return <Account key={userId} userId={userId} />;
}

function Account({ userId }: { userId: string }) {
  const { user: me } = useAuth();
  const directory = useDirectory();
  // Opening the account is recorded as this admin's read (ADR 0008). After an action the console
  // shows the account the action returned, rather than opening it again.
  const account = useAdminData(`account:${userId}`, (t) => adminApi.getUser(t, userId));
  const pending = useAdminData(`account:${userId}:pending`, (t) =>
    adminApi.roleRequests(t, { status: "PENDING", pageSize: 100 }),
  );
  const audit = useAdminData(`account:${userId}:audit`, (t) =>
    adminApi.audit(t, { targetUserId: userId, pageSize: 10 }),
  );
  const [latest, setLatest] = useState<AdminUser | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [known, setKnown] = useState<ReadonlySet<string> | null>(null);

  const shown = latest ?? account.data;
  const request = pending.data?.items.find(
    (r) => r.targetUserId.toLowerCase() === userId.toLowerCase(),
  );

  function acted(message: string, changed?: AdminUser) {
    setKnown(new Set(audit.data?.items.map((r) => r.id)));
    if (changed) setLatest(changed);
    setNotice(message);
    audit.reload();
    pending.reload();
    directory.reload();
  }

  return (
    <AdminShell
      active="/admin/users"
      heading={shown?.profile.displayName ?? "Account"}
      actions={
        <Link href="/admin/users" className={styles.link}>
          All users
        </Link>
      }
    >
      <FormAlert tone="success">{notice}</FormAlert>
      {account.error ? (
        <ErrorState title="Couldn't open this account" onRetry={account.reload}>
          {account.error.message}
        </ErrorState>
      ) : !shown ? (
        <LoadingState label="Opening the account…" rows={2} />
      ) : (
        <>
          <Section
            title="Account"
            description="Opening this account was recorded with your name, as every admin read of another account is."
          >
            <dl className={styles.facts}>
              <dt>Email</dt>
              <dd>{shown.email}</dd>
              <dt>Status</dt>
              <dd>
                <Tag tone={STATUS_TONES[shown.status]}>{ACCOUNT_STATUSES[shown.status]}</Tag>
              </dd>
              <dt>Role</dt>
              <dd>
                {shown.roles.includes("ADMIN")
                  ? shown.isSeededAdmin
                    ? "Bootstrap administrator (from deployment configuration)"
                    : "Administrator"
                  : "Student"}
              </dd>
              <dt>Joined</dt>
              <dd>{formatWhen(shown.createdAt)}</dd>
              <dt>Activated</dt>
              <dd>{shown.activatedAt ? formatWhen(shown.activatedAt) : "Not yet"}</dd>
              <dt>Account id</dt>
              <dd className={styles.mono}>{shown.id}</dd>
            </dl>
            <div className={styles.actions}>
              <Link href={`/admin/wallets?user=${shown.id}`} className={styles.link}>
                Wallet and ledger
              </Link>
              <Link href={`/admin/activity?target=${shown.id}`} className={styles.link}>
                Who opened this account
              </Link>
            </div>
          </Section>

          <Section title="Actions" description="Each asks for a reason, which the audit trail keeps.">
            <AccountActions account={shown} me={me?.id} pending={request} onDone={acted} />
          </Section>

          {request && (
            <Section title="Role change waiting for approval">
              <RoleRequestList
                requests={[request]}
                me={me?.id}
                onDecided={({ message, changed }) => acted(message, changed)}
              />
            </Section>
          )}

          <Section
            title="Audit trail for this account"
            actions={
              <Link href={`/admin/audit?target=${shown.id}`} className={styles.link}>
                Full audit trail
              </Link>
            }
          >
            <Loaded
              state={audit}
              label="audit records"
              isEmpty={(d) => d.items.length === 0}
              emptyTitle="No records yet"
              emptyText="Suspensions, reactivations and role changes for this account appear here."
            >
              {(d) => <AuditTable records={d.items} known={known} showTarget={false} />}
            </Loaded>
          </Section>
        </>
      )}
    </AdminShell>
  );
}
