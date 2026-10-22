"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Select } from "@/components/Select";
import { adminApi, type OrderStatus } from "@/lib/admin-api";
import { FINISHED_STATUSES, LIVE_STATUSES, ORDER_STATUS_ORDER, ORDER_STATUSES } from "@/lib/admin-labels";
import { ErrandTable } from "../_components/ErrandTable";
import { Loaded, Pager, Section } from "../_components/ui";
import { useAdminData } from "../_components/use-admin-data";

const PAGE_SIZE = 20;

/** What the list can be narrowed to: every errand, the live or finished ones, or one status. */
const FILTERS: Record<string, { label: string; status?: OrderStatus[] }> = {
  all: { label: "Every errand" },
  live: { label: "Live", status: LIVE_STATUSES },
  finished: { label: "Finished", status: FINISHED_STATUSES },
  ...Object.fromEntries(ORDER_STATUS_ORDER.map((s) => [s, { label: ORDER_STATUSES[s], status: [s] }])),
};

/**
 * ADM-06 (#279): every errand, live and past, newest first, read from the Order Service. Public
 * fields only, as on an account's page; each errand opens its trace.
 */
export function AllErrands() {
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const { status } = FILTERS[filter]!;
  const errands = useAdminData(`errands:all:${filter}:${page}`, (t) =>
    adminApi.errands(t, { status, page, pageSize: PAGE_SIZE }),
  );

  // An errand can change status between pages, so a narrowed list can shrink under a later page.
  // Step back to the last page that has any, as on an account's page.
  const lastPage = errands.data ? Math.max(1, Math.ceil(errands.data.total / PAGE_SIZE)) : page;
  if (!errands.loading && errands.data?.items.length === 0 && page > lastPage) setPage(lastPage);

  return (
    <Section
      title="Every errand"
      description="Every errand on FoC, live and past, newest first. Status and times from the Order Service; open an errand to see its full trace."
      actions={
        <>
          <Field label="Show">
            <Select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(1);
              }}
            >
              {Object.entries(FILTERS).map(([value, { label }]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="outline" onClick={errands.reload}>
            Refresh
          </Button>
        </>
      }
    >
      <Loaded
        state={errands}
        label="errands"
        isEmpty={(d) => d.total === 0}
        emptyTitle="No errands"
        emptyText={
          filter === "all" ? "Errands students post appear here, newest first." : "No errand is in that state right now."
        }
      >
        {(d) => (
          <>
            <ErrandTable page={d} caption="Every errand, newest first" />
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} label="Every errand: pages" />
          </>
        )}
      </Loaded>
    </Section>
  );
}
