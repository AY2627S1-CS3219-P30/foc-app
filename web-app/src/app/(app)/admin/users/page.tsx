"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { Select } from "@/components/Select";
import { adminApi, type AccountStatus, type Role, type UserQuery } from "@/lib/admin-api";
import { ACCOUNT_STATUSES, formatWhen, STATUS_TONES } from "@/lib/admin-labels";
import { AdminShell, Loaded, Pager, Section, Tag } from "../_components/ui";
import { useAdminData } from "../_components/use-admin-data";
import styles from "../_components/admin.module.css";

const PAGE_SIZE = 20;

export default function UsersPage() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<AccountStatus | "">("");
  const [role, setRole] = useState<Role | "">("");
  const [query, setQuery] = useState<UserQuery>({ page: 1, pageSize: PAGE_SIZE });
  // The directory: finding an account is not a read of it. Opening one is.
  const users = useAdminData(`users:${JSON.stringify(query)}`, (t) => adminApi.directory(t, query));

  function search(e: FormEvent) {
    e.preventDefault();
    setQuery({
      page: 1,
      pageSize: PAGE_SIZE,
      q: text.trim() || undefined,
      status: status || undefined,
      role: role || undefined,
    });
  }

  return (
    <AdminShell active="/admin/users" heading="Users">
      <Section
        title="Find an account"
        description="Search by the start of an email or display name. Opening an account is recorded, so other administrators can see who looked at it."
      >
        <form className={styles.filters} onSubmit={search} role="search">
          <Field label="Email or name">
            <Input type="search" value={text} onChange={(e) => setText(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as AccountStatus | "")}>
              <option value="">Any status</option>
              {(Object.keys(ACCOUNT_STATUSES) as AccountStatus[]).map((s) => (
                <option key={s} value={s}>
                  {ACCOUNT_STATUSES[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role | "")}>
              <option value="">Any role</option>
              <option value="ADMIN">Administrators</option>
              <option value="STUDENT">Students</option>
            </Select>
          </Field>
          <Button type="submit">Search</Button>
        </form>

        <Loaded
          state={users}
          label="accounts"
          isEmpty={(d) => d.items.length === 0}
          emptyTitle="No accounts match"
          emptyText="Try the start of the email address, or clear the filters."
        >
          {(d) => (
            <>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption className="srOnly">
                    Accounts, {d.total} in all, page {d.page}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col">Status</th>
                      <th scope="col">Roles</th>
                      <th scope="col">Joined</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <Link href={`/admin/users/${u.id}`} className={styles.link}>
                            {u.displayName}
                          </Link>
                          <span className={styles.secondary}>{u.email}</span>
                        </td>
                        <td>
                          <Tag tone={STATUS_TONES[u.status]}>{ACCOUNT_STATUSES[u.status]}</Tag>
                        </td>
                        <td>
                          <div className={styles.tags}>
                            {u.roles.includes("ADMIN") ? (
                              <Tag tone="info">{u.isSeededAdmin ? "Bootstrap admin" : "Administrator"}</Tag>
                            ) : (
                              <Tag>Student</Tag>
                            )}
                          </div>
                        </td>
                        <td className={styles.nowrap}>{formatWhen(u.createdAt)}</td>
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
    </AdminShell>
  );
}
