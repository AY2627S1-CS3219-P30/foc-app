"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DesktopPanel } from "@/components/DesktopPanel";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useStore } from "@/lib/store";

export default function NewRequestLocationPage() {
  const { state } = useStore();
  const router = useRouter();
  const [query, setQuery] = useState("");

  const matches = useMemo(
    () =>
      state.suppliers.filter((s) =>
        `${s.name} ${s.location}`.toLowerCase().includes(query.toLowerCase())
      ),
    [state.suppliers, query]
  );

  function pick(supplierName: string, location: string) {
    const params = new URLSearchParams({ supplier: supplierName, dropoff: location });
    router.push(`/request/new/details?${params.toString()}`);
  }

  const body = (
    <>
      <input
        className="text-input"
        placeholder="Type a location..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="field-label" style={{ marginTop: 12 }}>
        Pick a pickup point
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {matches.map((s) => (
          <button
            key={s.id}
            className="card"
            style={{ textAlign: "left" }}
            onClick={() => pick(s.name, s.location)}
          >
            <p style={{ fontWeight: 600, fontSize: 15 }}>{s.name}</p>
            <p style={{ fontSize: 13, color: "var(--color-text-subtle)" }}>{s.location}</p>
          </button>
        ))}
        {matches.length === 0 && (
          <p style={{ color: "var(--color-text-subtle)", fontSize: 14 }}>No matches.</p>
        )}
      </div>
    </>
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <ScreenHeader title="New request" onBack={() => router.push("/feed")} />
          <ScreenContent>{body}</ScreenContent>
        </Screen>
      </div>
      <div className="desktopOnly">
        <DesktopPanel title="New request" onBack={() => router.push("/feed")} width={480}>
          {body}
        </DesktopPanel>
      </div>
    </>
  );
}
