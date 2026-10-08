"use client";

import { useState } from "react";
import { FilterChip } from "@/components/FilterChip";
import { FormAlert } from "@/components/FormField";
import { adminApi, type RoleRequestStatus } from "@/lib/admin-api";
import { REQUEST_STATUSES } from "@/lib/admin-labels";
import { useAuth } from "@/lib/auth";
import { RoleRequestList } from "../_components/RoleRequestList";
import { AdminShell, Loaded, Pager, Section } from "../_components/ui";
import { useAdminData } from "../_components/use-admin-data";
import styles from "../_components/admin.module.css";

const PAGE_SIZE = 20;
const FILTERS: (RoleRequestStatus | undefined)[] = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", undefined];

export default function RoleRequestsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<RoleRequestStatus | undefined>("PENDING");
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const requests = useAdminData(`role-requests:${status ?? "all"}:${page}`, (t) =>
    adminApi.roleRequests(t, { status, page, pageSize: PAGE_SIZE }),
  );

  return (
    <AdminShell active="/admin/role-requests" heading="Role requests">
      <Section
        title="Two people for every role change"
        description="Appointing or removing an administrator is a request until an active administrator other than the requester and the person concerned approves it. Approving needs your password; an undecided request expires after a day."
      >
        <div className={styles.chips} role="group" aria-label="Show requests">
          {FILTERS.map((s) => (
            <FilterChip
              key={s ?? "all"}
              label={s ? REQUEST_STATUSES[s] : "All"}
              selected={status === s}
              onClick={() => {
                setStatus(s);
                setPage(1);
              }}
            />
          ))}
        </div>
        <FormAlert tone="success">{notice}</FormAlert>
        <Loaded
          state={requests}
          label="role requests"
          isEmpty={(d) => d.items.length === 0}
          emptyTitle="No requests"
          emptyText={status === "PENDING" ? "Nothing is waiting for approval." : "No requests match."}
        >
          {(d) => (
            <>
              <RoleRequestList
                requests={d.items}
                me={user?.id}
                onDecided={({ message }) => {
                  setNotice(message);
                  requests.reload();
                }}
              />
              <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </Loaded>
      </Section>
    </AdminShell>
  );
}
