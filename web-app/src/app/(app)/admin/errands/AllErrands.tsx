"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Select } from "@/components/Select";
import type { OrderStatus } from "@/lib/admin-api";
import { FINISHED_STATUSES, LIVE_STATUSES, ORDER_STATUS_ORDER, ORDER_STATUSES } from "@/lib/admin-labels";
import { PagedErrands } from "../_components/PagedErrands";
import { Section } from "../_components/ui";

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
  const [refreshKey, setRefreshKey] = useState(0);
  const { status } = FILTERS[filter]!;

  return (
    <Section
      title="Every errand"
      description="Every errand on FoC, live and past, newest first. Status and times from the Order Service; open an errand to see its full trace."
      actions={
        <>
          <Field label="Show">
            <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {Object.entries(FILTERS).map(([value, { label }]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="outline" onClick={() => setRefreshKey((k) => k + 1)}>
            Refresh
          </Button>
        </>
      }
    >
      <PagedErrands
        filter={{ status }}
        pageSize={PAGE_SIZE}
        refreshKey={refreshKey}
        caption="Every errand, newest first"
        pagerLabel="Every errand: pages"
        emptyTitle="No errands"
        emptyText={
          filter === "all" ? "Errands students post appear here, newest first." : "No errand is in that state right now."
        }
      />
    </Section>
  );
}
