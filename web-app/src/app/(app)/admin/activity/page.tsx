"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { Select } from "@/components/Select";
import { LoadingState } from "@/components/States";
import { adminApi, type AdminAlertKind, type ReadsQuery } from "@/lib/admin-api";
import { ALERT_KINDS, describeAlert, formatWhen } from "@/lib/admin-labels";
import { useQueryParam } from "@/lib/use-query-param";
import { useDirectory } from "../_components/Directory";
import { AdminShell, Loaded, Pager, Section, Tag, UserLink } from "../_components/ui";
import { useAccountInput } from "../_components/use-account-input";
import { useAdminData } from "../_components/use-admin-data";
import styles from "../_components/admin.module.css";

const PAGE_SIZE = 20;

export default function ActivityPage() {
  const target = useQueryParam("target");
  return (
    <AdminShell active="/admin/activity" heading="Admin activity">
      <Alerts />
      {target === undefined ? (
        <LoadingState label="Loading account reads…" rows={2} />
      ) : (
        <Reads initialTarget={target ?? ""} />
      )}
    </AdminShell>
  );
}

/** Unusual admin activity (ADR 0008), newest first. */
function Alerts() {
  const { name } = useDirectory();
  const [kind, setKind] = useState<AdminAlertKind | "">("");
  const [page, setPage] = useState(1);
  const alerts = useAdminData(`alerts:${kind}:${page}`, (t) =>
    adminApi.alerts(t, { kind: kind || undefined, page, pageSize: PAGE_SIZE }),
  );

  return (
    <Section
      title="Alerts"
      description="Raised when a role changes, an administrator is suspended, or one administrator suspends or opens many accounts within an hour. Each is also written to the service log."
      actions={
        <Field label="Show">
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as AdminAlertKind | "");
              setPage(1);
            }}
          >
            <option value="">Every alert</option>
            {(Object.keys(ALERT_KINDS) as AdminAlertKind[]).map((k) => (
              <option key={k} value={k}>
                {ALERT_KINDS[k]}
              </option>
            ))}
          </Select>
        </Field>
      }
    >
      <Loaded
        state={alerts}
        label="alerts"
        isEmpty={(d) => d.items.length === 0}
        emptyTitle="No alerts"
        emptyText="Nothing unusual has happened."
      >
        {(d) => (
          <>
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
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </Loaded>
    </Section>
  );
}

/** Which administrator opened which account (ADR 0008). */
function Reads({ initialTarget }: { initialTarget: string }) {
  const actor = useAccountInput("");
  const target = useAccountInput(initialTarget);
  const [query, setQuery] = useState<ReadsQuery>({
    page: 1,
    pageSize: PAGE_SIZE,
    targetUserId: initialTarget || undefined,
  });
  const reads = useAdminData(`reads:${JSON.stringify(query)}`, (t) => adminApi.reads(t, query));

  function apply(e: FormEvent) {
    e.preventDefault();
    const actorId = actor.resolve();
    const targetUserId = target.resolve();
    if (actorId === null || targetUserId === null) return;
    setQuery({ page: 1, pageSize: PAGE_SIZE, actorId, targetUserId });
  }

  return (
    <Section
      title="Accounts opened by administrators"
      description="Recorded each time an administrator reads another person's full account, one at a time or in a list. Finding accounts in the directory is not recorded."
    >
      <form className={styles.filters} onSubmit={apply} role="search" aria-label="Filter account reads">
        <Field label="Administrator (email or id)" error={actor.error}>
          <Input value={actor.text} onChange={(e) => actor.setText(e.target.value)} />
        </Field>
        <Field label="Account opened (email or id)" error={target.error}>
          <Input value={target.text} onChange={(e) => target.setText(e.target.value)} />
        </Field>
        <Button type="submit">Filter</Button>
      </form>
      <Loaded
        state={reads}
        label="account reads"
        isEmpty={(d) => d.items.length === 0}
        emptyTitle="No reads match"
        emptyText="No administrator has opened a matching account."
      >
        {(d) => (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="srOnly">Account reads, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Administrator</th>
                    <th scope="col">Account opened</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((r) => (
                    <tr key={r.id}>
                      <td className={styles.nowrap}>{formatWhen(r.occurredAt)}</td>
                      <td>
                        <UserLink id={r.actorId} />
                      </td>
                      <td>
                        <UserLink id={r.targetUserId} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={d.page}
              pageSize={d.pageSize}
              total={d.total}
              onPage={(page) => setQuery((q) => ({ ...q, page }))}
            />
          </>
        )}
      </Loaded>
    </Section>
  );
}
