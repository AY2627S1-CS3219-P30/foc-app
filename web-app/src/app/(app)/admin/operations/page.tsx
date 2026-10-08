"use client";

import { AdminShell, Section } from "../_components/ui";
import styles from "../_components/admin.module.css";

export default function OperationsPage() {
  return (
    <AdminShell active="/admin/operations" heading="Operations">
      <Section
        title="Dead letters and redrive"
        description="Messages a service could not process, and the means to send them again."
      >
        <p className={styles.muted}>
          Arrives with PLT-05 (#154): each service&apos;s dead-letter queue with what failed and why,
          a redrive that sends a message again unchanged and records who did it, and the platform
          alerts.
        </p>
      </Section>
      <Section
        title="Service health and metrics"
        description="Request rates, errors and latency for every service."
      >
        <p className={styles.muted}>
          The platform dashboard (PLT-04) runs in Grafana beside the Compose stack, on port 3005.
          PLT-05 brings its alerts into this console.
        </p>
      </Section>
    </AdminShell>
  );
}
