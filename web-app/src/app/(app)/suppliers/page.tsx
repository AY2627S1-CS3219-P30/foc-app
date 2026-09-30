"use client";

import { useMemo, useState } from "react";
import { AppBar } from "@/components/AppBar";
import { DesktopShell } from "@/components/DesktopShell";
import { Field } from "@/components/Field";
import { FilterChip } from "@/components/FilterChip";
import { Input } from "@/components/Input";
import { Screen, ScreenContent } from "@/components/Screen";
import { EmptyState } from "@/components/States";
import { SupplierCard } from "@/components/SupplierCard";
import { STUDENT_NAV } from "@/lib/nav";
import { useStore } from "@/lib/store";
import { vars } from "@/styles/tokens";

const CATEGORIES = ["All", "Café", "Printers", "Marts"];

export default function SuppliersPage() {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");

  const suppliers = useMemo(
    () =>
      state.suppliers.filter((s) => {
        const matchesCategory = category === "All" || s.category === category;
        const matchesQuery = `${s.name} ${s.location}`.toLowerCase().includes(query.toLowerCase());
        return matchesCategory && matchesQuery;
      }),
    [state.suppliers, query, category]
  );

  const filters = (
    <>
      <Field label="Search suppliers">
        <Input
          type="search"
          placeholder="Type a location..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      <div
        style={{ display: "flex", gap: vars.space[2], overflowX: "auto", margin: `${vars.space[3]} 0` }}
      >
        {CATEGORIES.map((c) => (
          <FilterChip key={c} label={c} selected={category === c} onClick={() => setCategory(c)} />
        ))}
      </div>
    </>
  );

  const empty = (
    <EmptyState title="No suppliers match">Try another search or category.</EmptyState>
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <AppBar title="Suppliers" />
          <ScreenContent>
            {filters}
            {suppliers.map((s) => (
              <SupplierCard key={s.id} supplier={s} />
            ))}
            {suppliers.length === 0 && empty}
          </ScreenContent>
        </Screen>
      </div>

      <div className="desktopOnly">
        <DesktopShell navItems={STUDENT_NAV} activeHref="/suppliers" heading="Campus suppliers">
          <div style={{ maxWidth: 640, marginBottom: vars.space[4] }}>{filters}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: vars.space[3], maxWidth: 640 }}>
            {suppliers.map((s) => (
              <SupplierCard key={s.id} supplier={s} />
            ))}
            {suppliers.length === 0 && empty}
          </div>
        </DesktopShell>
      </div>
    </>
  );
}
