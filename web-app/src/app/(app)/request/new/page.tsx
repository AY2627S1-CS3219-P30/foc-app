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
    <ResponsiveShell title="New request" navItems={STUDENT_NAV} activeHref="/feed">
      <SupplierPicker onSelect={pick} />
    </ResponsiveShell>
  );
}
