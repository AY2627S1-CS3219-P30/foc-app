"use client";

import { useState } from "react";
import { GRAFANA_URL } from "@/lib/admin-api";
import { useQueryParam } from "@/lib/use-query-param";
import { AdminShell, Section } from "../_components/ui";
import styles from "../_components/admin.module.css";
import { DeadLetters } from "./DeadLetters";
import { ErrandTrace } from "./ErrandTrace";
import { OperationalAlerts } from "./OperationalAlerts";

/**
 * PLT-05 (#154) — the operator's tab: what needs attention, each service's dead letters with the
 * one action here (a redrive), and one errand's full trace. `?order=<id>` opens on that errand.
 */
export default function OperationsPage() {
  const fromUrl = useQueryParam("order");
  const [traced, setTraced] = useState<string | null>(null);
  // Bumped by a redrive, so the figures and the trace show its effect.
  const [reloadKey, setReloadKey] = useState(0);

  function trace(orderId: string) {
    setTraced(orderId);
    document.getElementById("trace")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <AdminShell active="/admin/operations" heading="Operations">
      <OperationalAlerts reloadKey={reloadKey} onTrace={trace} />
      <div id="dead-letters">
        <DeadLetters onTrace={trace} onRedriven={() => setReloadKey((k) => k + 1)} />
      </div>
      <div id="trace">
        <ErrandTrace orderId={traced ?? fromUrl ?? null} reloadKey={reloadKey} onTrace={trace} />
      </div>
      <Section
        title="Service health and metrics"
        description="Request rates, latency, consumer lag, retries, dead letters and errands waiting for credits, for every service, with the alerts that are firing."
      >
        {GRAFANA_URL ? (
          <p className={styles.muted}>
            <a href={GRAFANA_URL} target="_blank" rel="noreferrer" className={styles.link}>
              Open the platform dashboard
            </a>{" "}
            (Grafana, opens in a new tab). A dead letter, an errand waiting more than five minutes for
            credits, or a service that stops answering raises an alert there.
          </p>
        ) : (
          <p className={styles.muted}>
            The platform dashboard runs in Grafana beside the Compose stack. This build was not given
            its address (NEXT_PUBLIC_GRAFANA_URL).
          </p>
        )}
      </Section>
    </AdminShell>
  );
}
