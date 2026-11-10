// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-10-21
// Scope: Implementation for "supplier picker and deletion hold" (WEB-00, SUP-04); also bug fixes.
// Author review: Patrick Thomas validated correctness and the implementation, and checked for fatal
//   errors and architectural conflicts, before committing.

"use client";

import { useRouter } from "next/navigation";
import { ResponsiveShell } from "@/components/ResponsiveShell";
import { SupplierPicker } from "@/components/SupplierPicker";
import { STUDENT_NAV } from "@/lib/nav";
import type { SupplierSummary } from "@/lib/supplier-api";

/** One tree for every width because the picker holds a search field: see decisions.md W3. */
export default function NewRequestLocationPage() {
  const router = useRouter();

  function pick(supplier: SupplierSummary) {
    const params = new URLSearchParams({ supplierId: supplier.supplierId });
    router.push(`/request/new/details?${params.toString()}`);
  }

  return (
    <ResponsiveShell
      title="New request"
      navItems={STUDENT_NAV}
      activeHref="/feed"
      onBack={() => router.push("/feed")}
    >
      <SupplierPicker onSelect={pick} />
    </ResponsiveShell>
  );
}
