"use client";

import { useMemo } from "react";
import { DesktopShell } from "@/components/DesktopShell";
import { OrdersTable } from "@/components/OrdersTable";
import { StatCard } from "@/components/StatCard";
import { ADMIN_NAV } from "@/lib/nav";
import { useStore } from "@/lib/store";

export default function AdminDashboardPage() {
  const { state } = useStore();

  const stats = useMemo(() => {
    const live = state.requests.filter((r) => r.status === "accepted" || r.status === "in_transit").length;
    const completed = state.requests.filter((r) => r.status === "complete").length;
    const open = state.requests.filter((r) => r.status === "open").length;
    return { live, completed, open };
  }, [state.requests]);

  const orders = useMemo(
    () => [...state.requests].sort((a, b) => b.createdAt - a.createdAt),
    [state.requests]
  );

  return (
    <DesktopShell
      navItems={ADMIN_NAV}
      activeHref="/admin"
      logoText="NUQueSt Admin"
      showCreditPill={false}
      heading="Overview"
    >
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
        <StatCard label="Live orders" value={stats.live} />
        <StatCard label="Completed" value={stats.completed} />
        <StatCard label="Open requests" value={stats.open} />
        <StatCard label="Credits reserved" value={state.reserved} />
      </div>
      <OrdersTable requests={orders} />
    </DesktopShell>
  );
}
