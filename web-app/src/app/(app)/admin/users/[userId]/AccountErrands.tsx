"use client";

import { PagedErrands } from "../../_components/PagedErrands";
import { Section } from "../../_components/ui";

const PAGE_SIZE = 10;

/**
 * ADM-05: the account's errands, read from the Order Service (ORD-15). Each list loads on its own,
 * so when the Order Service does not answer, only these sections say so and the rest of the account
 * page still works. The service refuses anyone who is not an administrator. Changing `refreshKey`
 * loads both lists again.
 */
export function AccountErrands({ userId, refreshKey = 0 }: { userId: string; refreshKey?: number }) {
  return (
    <>
      <ErrandList
        userId={userId}
        refreshKey={refreshKey}
        role="requester"
        title="Errands they requested"
        emptyTitle="No errands requested"
        emptyText="Errands this account posts appear here, newest first."
      />
      <ErrandList
        userId={userId}
        refreshKey={refreshKey}
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
  refreshKey,
  role,
  title,
  emptyTitle,
  emptyText,
}: {
  userId: string;
  refreshKey: number;
  role: "requester" | "courier";
  title: string;
  emptyTitle: string;
  emptyText: string;
}) {
  return (
    <Section title={title} description="Status and times from the Order Service. Open an errand to see its full trace.">
      <PagedErrands
        filter={role === "requester" ? { requesterId: userId } : { courierId: userId }}
        pageSize={PAGE_SIZE}
        refreshKey={refreshKey}
        caption={`${title}, newest first`}
        pagerLabel={`${title}: pages`}
        emptyTitle={emptyTitle}
        emptyText={emptyText}
      />
    </Section>
  );
}
