"use client";

import { useMemo, useState } from "react";
import { AppBar } from "@/components/AppBar";
import { DesktopShell } from "@/components/DesktopShell";
import { FilterChip } from "@/components/FilterChip";
import { Screen, ScreenContent } from "@/components/Screen";
import { SupplierCard } from "@/components/SupplierCard";
import { STUDENT_NAV } from "@/lib/nav";
import { useStore } from "@/lib/store";

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
      <input
        className="text-input"
        placeholder="Type a location..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, overflowX: "auto", margin: "12px 0" }}>
        {CATEGORIES.map((c) => (
          <FilterChip key={c} label={c} selected={category === c} onClick={() => setCategory(c)} />
        ))}
      </div>
    </>
  );

  const empty = <p style={{ color: "var(--color-text-subtle)", fontSize: 14 }}>No suppliers match.</p>;

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
          <div style={{ maxWidth: 640, marginBottom: 16 }}>{filters}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
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
