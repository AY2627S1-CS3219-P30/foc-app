"use client";

import Link from "next/link";
import { useState } from "react";
import { FormAlert } from "@/components/FormField";
import { adminApi } from "@/lib/admin-api";
import { describeAlert, formatWhen, ALERT_KINDS } from "@/lib/admin-labels";
import { useAuth } from "@/lib/auth";
import { useDirectory } from "./_components/Directory";
import { RoleRequestList } from "./_components/RoleRequestList";
import { AdminShell, Loaded, Section, Stat, Tag } from "./_components/ui";
import { figure, useAdminData } from "./_components/use-admin-data";
import styles from "./_components/admin.module.css";

export default function AdminOverviewPage() {
  const { user } = useAuth();
  const { name } = useDirectory();
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useAdminData("overview:pending", (t) =>
    adminApi.roleRequests(t, { status: "PENDING", pageSize: 100 }),
  );
  const alerts = useAdminData("overview:alerts", (t) => adminApi.alerts(t, { pageSize: 5 }));
  const waits = useAdminData("overview:waits", (t) => adminApi.creditWaits(t));
  const reconciliation = useAdminData("overview:reconciliation", (t) => adminApi.reconciliation(t));
  const deadOrder = useAdminData("overview:dead-order", (t) =>
    adminApi.deadLetters(t, "order", { status: "WAITING", pageSize: 1 }),
  );
  const deadCredit = useAdminData("overview:dead-credit", (t) =>
    adminApi.deadLetters(t, "credit", { status: "WAITING", pageSize: 1 }),
  );
  const order = figure(deadOrder, (d) => d.total);
  const credit = figure(deadCredit, (d) => d.total);
  // Either service not answering makes the sum unknown, not smaller.
  const deadLetters =
    order === null || credit === null ? null : order === undefined || credit === undefined ? undefined : order + credit;

  return (
    <AdminShell active="/admin" heading="Overview">
      <div className={styles.stats}>
        <Stat
          href="/admin/role-requests"
          label="Role changes waiting"
          value={figure(pending, (d) => d.total)}
        />
        <Stat href="/admin/activity" label="Admin alerts" value={figure(alerts, (d) => d.total)} />
        <Stat
          href="/admin/errands"
          label="Errands waiting on credits"
          value={figure(waits, (d) => d.items.length)}
        />
        <Stat
          href="/admin/errands"
          label="Credit contradictions"
          value={figure(reconciliation, (d) => d.items.filter((a) => a.action === "ALERTED").length)}
        />
        <Stat href="/admin/operations" label="Dead letters waiting" value={deadLetters} />
      </div>

      <Section
        title="Waiting for a second administrator"
        description="Role changes only take effect once an administrator other than the requester and the person concerned approves them."
        actions={
          <Link href="/admin/role-requests" className={styles.link}>
            All role requests
          </Link>
        }
      >
        <FormAlert tone="success">{notice}</FormAlert>
        <Loaded
          state={pending}
          label="role requests"
          isEmpty={(d) => d.items.length === 0}
          emptyTitle="Nothing is waiting"
          emptyText="Role changes another administrator asks for appear here."
        >
          {(d) => (
            <RoleRequestList
              requests={d.items}
              me={user?.id}
              onDecided={({ message }) => {
                setNotice(message);
                pending.reload();
                alerts.reload();
              }}
            />
          )}
        </Loaded>
      </Section>

      <Section
        title="Latest admin alerts"
        actions={
          <Link href="/admin/activity" className={styles.link}>
            All alerts
          </Link>
        }
      >
        <Loaded
          state={alerts}
          label="alerts"
          isEmpty={(d) => d.items.length === 0}
          emptyTitle="No alerts"
          emptyText="Role changes, suspended administrators and unusual bulk activity raise alerts here."
        >
          {(d) => (
            <ul className={styles.list}>
              {d.items.map((alert) => (
                <li key={alert.id} className={styles.item}>
                  <div className={styles.tags}>
                    <Tag tone={alert.kind === "ROLE_CHANGE" ? "info" : "warning"}>
                      {ALERT_KINDS[alert.kind]}
                    </Tag>
                    <span className={styles.secondary}>{formatWhen(alert.occurredAt)}</span>
                  </div>
                  <span>{describeAlert(alert, name)}</span>
                </li>
              ))}
            </ul>
          )}
        </Loaded>
      </Section>
    </AdminShell>
  );
}
