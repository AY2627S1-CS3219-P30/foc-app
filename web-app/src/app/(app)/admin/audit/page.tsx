"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { Select } from "@/components/Select";
import { LoadingState } from "@/components/States";
import { adminApi, type AuditAction, type AuditQuery } from "@/lib/admin-api";
import { AUDIT_ACTIONS, dayRange } from "@/lib/admin-labels";
import { useQueryParam } from "@/lib/use-query-param";
import { AuditTable } from "../_components/AuditTable";
import { useDirectory } from "../_components/Directory";
import { AdminShell, Loaded, Pager, Section } from "../_components/ui";
import { useAccountInput } from "../_components/use-account-input";
import { useAdminData } from "../_components/use-admin-data";
import styles from "../_components/admin.module.css";

const PAGE_SIZE = 25;

export default function AuditPage() {
  const target = useQueryParam("target");
  return (
    <AdminShell active="/admin/audit" heading="Audit trail">
      {target === undefined ? (
        <LoadingState label="Loading the audit trail…" rows={2} />
      ) : (
        <AuditView initialTarget={target ?? ""} />
      )}
    </AdminShell>
  );
}

function AuditView({ initialTarget }: { initialTarget: string }) {
  const { name } = useDirectory();
  const actor = useAccountInput("");
  const target = useAccountInput(initialTarget);
  const [action, setAction] = useState<AuditAction | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState<AuditQuery>({
    page: 1,
    pageSize: PAGE_SIZE,
    targetUserId: initialTarget || undefined,
  });
  const records = useAdminData(`audit:${JSON.stringify(query)}`, (t) => adminApi.audit(t, query));

  function apply(e: FormEvent) {
    e.preventDefault();
    const actorId = actor.resolve();
    const targetUserId = target.resolve();
    if (actorId === null || targetUserId === null) return;
    setQuery({
      page: 1,
      pageSize: PAGE_SIZE,
      actorId,
      targetUserId,
      action: action || undefined,
      ...dayRange(from, to),
    });
  }

  return (
    <Section
      title="Every suspension, reactivation and role change"
      description="Append-only: no one can edit or delete a record, and each names the administrator and their reason. Bootstraps from deployment configuration are recorded as the system."
    >
      <form className={styles.filters} onSubmit={apply} role="search" aria-label="Filter the audit trail">
        <Field label="By (email or id)" error={actor.error}>
          <Input value={actor.text} onChange={(e) => actor.setText(e.target.value)} />
        </Field>
        <Field label="Account (email or id)" error={target.error}>
          <Input value={target.text} onChange={(e) => target.setText(e.target.value)} />
        </Field>
        <Field label="Action">
          <Select value={action} onChange={(e) => setAction(e.target.value as AuditAction | "")}>
            <option value="">Any action</option>
            {(Object.keys(AUDIT_ACTIONS) as AuditAction[]).map((a) => (
              <option key={a} value={a}>
                {AUDIT_ACTIONS[a]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Button type="submit">Filter</Button>
      </form>
      {query.targetUserId && (
        <p className={styles.muted}>Showing records about {name(query.targetUserId)}.</p>
      )}
      <Loaded
        state={records}
        label="audit records"
        isEmpty={(d) => d.items.length === 0}
        emptyTitle="No records match"
        emptyText="Widen the dates or clear a filter."
      >
        {(d) => (
          <>
            <AuditTable records={d.items} />
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
