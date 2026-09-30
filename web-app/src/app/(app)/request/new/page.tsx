"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DesktopPanel } from "@/components/DesktopPanel";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { Screen, ScreenContent } from "@/components/Screen";
import { ScreenHeader } from "@/components/ScreenHeader";
import { EmptyState } from "@/components/States";
import { useStore } from "@/lib/store";
import { vars } from "@/styles/tokens";

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
      <Field label="Search pickup points">
        <Input
          type="search"
          placeholder="Type a location..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      <div style={{ display: "flex", flexDirection: "column", gap: vars.space[2] }}>
        {matches.map((s) => (
          <button
            key={s.id}
            className="card"
            style={{ textAlign: "left" }}
            onClick={() => pick(s.name, s.location)}
          >
            <p style={{ fontWeight: vars.weight.semibold, fontSize: vars.text.lg }}>{s.name}</p>
            <p style={{ fontSize: vars.text.sm, color: vars.color.textSubtle }}>{s.location}</p>
          </button>
        ))}
        {matches.length === 0 && <EmptyState title="No pickup points match" />}
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
