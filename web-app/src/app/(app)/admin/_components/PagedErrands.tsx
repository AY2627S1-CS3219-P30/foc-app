"use client";

import { useState } from "react";
import { adminApi, type ErrandQuery } from "@/lib/admin-api";
import { ErrandTable } from "./ErrandTable";
import { Loaded, Pager } from "./ui";
import { useAdminData } from "./use-admin-data";

/** Which errands a list shows: an account's, some statuses, or every errand. */
export type ErrandFilter = Omit<ErrandQuery, "page" | "pageSize" | "before">;

/**
 * Pages through the Order Service's admin errand list, newest first. Each later page starts after
 * the last errand the page before it showed (`before`), so errands posted meanwhile, or ones that
 * leave the filter, neither repeat nor skip rows. A new `filter` starts again from the newest; a
 * new `refreshKey` loads the page shown again.
 */
export function PagedErrands({
  filter,
  pageSize,
  refreshKey = 0,
  caption,
  pagerLabel,
  emptyTitle,
  emptyText,
}: {
  filter: ErrandFilter;
  pageSize: number;
  refreshKey?: number;
  caption: string;
  /** Names the pager's landmark; give each list on a page its own. */
  pagerLabel: string;
  emptyTitle: string;
  emptyText: string;
}) {
  const list = JSON.stringify(filter);
  // The last errand of each page turned past, kept with the filter it pages, so a new filter
  // starts from the newest without an effect.
  const [turned, setTurned] = useState<{ list: string; after: string[] }>({ list, after: [] });
  const after = turned.list === list ? turned.after : [];
  const before = after.at(-1);
  const errands = useAdminData(`errands:${list}:${pageSize}:${before ?? ""}:${refreshKey}`, (t) =>
    adminApi.errands(t, { ...filter, pageSize, ...(before && { before }) }),
  );

  // Every errand after the last one shown can leave the list before the next page is asked for (a
  // courier withdraws, an errand finishes), so a later page can come back empty. Step back a page
  // rather than show the list as empty with no way back.
  if (!errands.loading && errands.data?.items.length === 0 && after.length > 0)
    setTurned({ list, after: after.slice(0, -1) });

  const page = after.length + 1;
  return (
    <Loaded state={errands} label="errands" isEmpty={(d) => d.total === 0} emptyTitle={emptyTitle} emptyText={emptyText}>
      {(d) => (
        <>
          <ErrandTable page={d} caption={caption} />
          {/* `total` counts the errands from this page on, after the pages already turned. */}
          <Pager
            page={page}
            pageSize={pageSize}
            total={after.length * pageSize + d.total}
            onPage={(to) =>
              setTurned({ list, after: to > page ? [...after, d.items.at(-1)!.orderId] : after.slice(0, -1) })
            }
            label={pagerLabel}
          />
        </>
      )}
    </Loaded>
  );
}
