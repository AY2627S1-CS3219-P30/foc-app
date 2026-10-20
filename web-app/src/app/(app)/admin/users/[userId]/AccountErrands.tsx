"use client";

import { useState } from "react";
import { adminApi, type AccountErrandPage, type AccountErrandQuery } from "@/lib/admin-api";
import { formatWhen, ORDER_STATUSES, ORDER_TONES } from "@/lib/admin-labels";
import { Loaded, Pager, Section, Tag, TraceLink } from "../../_components/ui";
import { useAdminData } from "../../_components/use-admin-data";
import styles from "../../_components/admin.module.css";

const PAGE_SIZE = 10;

/**
 * ADM-05: the account's errands, read from the Order Service (ORD-15). Each list loads on its own,
 * so when the Order Service does not answer, only these sections say so and the rest of the account
 * page still works. The service refuses anyone who is not an administrator.
 */
export function AccountErrands({ userId }: { userId: string }) {
  return (
    <>
      <ErrandList
        userId={userId}
        role="requester"
        title="Errands they requested"
        emptyTitle="No errands requested"
        emptyText="Errands this account posts appear here, newest first."
      />
      <ErrandList
        userId={userId}
        role="courier"
        title="Errands they hold as courier"
        emptyTitle="No errands as courier"
        emptyText="Errands this account accepted appear here, newest first. One it withdrew from or timed out on is not listed."
      />
    </>
  );
}

function ErrandList({
  userId,
  role,
  title,
  emptyTitle,
  emptyText,
}: {
  userId: string;
  role: "requester" | "courier";
  title: string;
  emptyTitle: string;
  emptyText: string;
}) {
  const [page, setPage] = useState(1);
  const query: AccountErrandQuery =
    role === "requester"
      ? { requesterId: userId, page, pageSize: PAGE_SIZE }
      : { courierId: userId, page, pageSize: PAGE_SIZE };
  const errands = useAdminData(`account:${userId}:errands:${role}:${page}`, (t) =>
    adminApi.accountErrands(t, query),
  );

  return (
    <Section title={title} description="Status and times from the Order Service. Open an errand to see its full trace.">
      <Loaded
        state={errands}
        label="errands"
        isEmpty={(d) => d.items.length === 0}
        emptyTitle={emptyTitle}
        emptyText={emptyText}
      >
        {(d) => (
          <>
            <ErrandTable page={d} caption={`${title}, newest first`} />
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </Loaded>
    </Section>
  );
}

function ErrandTable({ page, caption }: { page: AccountErrandPage; caption: string }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="srOnly">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Errand</th>
            <th scope="col">Status</th>
            <th scope="col">Supplier</th>
            <th scope="col" className={styles.number}>
              Reward
            </th>
            <th scope="col">Posted</th>
            <th scope="col">Last change</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((e) => (
            <tr key={e.orderId}>
              <td>
                <TraceLink orderId={e.orderId} />
              </td>
              <td>
                <Tag tone={ORDER_TONES[e.status]}>{ORDER_STATUSES[e.status]}</Tag>
              </td>
              <td>{e.supplier.name}</td>
              <td className={styles.number}>{e.reward}</td>
              <td className={styles.nowrap}>{formatWhen(e.createdAt)}</td>
              <td className={styles.nowrap}>{formatWhen(e.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
