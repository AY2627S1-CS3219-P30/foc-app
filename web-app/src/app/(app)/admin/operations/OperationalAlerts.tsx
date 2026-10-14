"use client";

import { Button } from "@/components/Button";
import { adminApi, type CreditAuditAlert, type OperatorAlert } from "@/lib/admin-api";
import { formatWhen, shortId } from "@/lib/admin-labels";
import { creditAlertLabel, OPERATOR_ALERT_KINDS } from "@/lib/errand-trace";
import { Loaded, Section, Stat, Tag } from "../_components/ui";
import { figure, useAdminData, type AdminData } from "../_components/use-admin-data";
import styles from "../_components/admin.module.css";

type Alert =
  | { source: "Order"; at: string; orderId: string; alert: OperatorAlert }
  | { source: "Credit"; at: string; orderId: string; alert: CreditAuditAlert };

/**
 * PLT-05 (EI-NFR4.1.2) — what needs an operator now: dead letters waiting in either service, and
 * the alerts both services raise about errands. `reloadKey` changes after a redrive.
 */
export function OperationalAlerts({
  reloadKey,
  onTrace,
}: {
  reloadKey: number;
  onTrace: (orderId: string) => void;
}) {
  const waitingOrder = useAdminData(`ops:dl-order:${reloadKey}`, (t) =>
    adminApi.deadLetters(t, "order", { status: "WAITING", pageSize: 1 }),
  );
  const waitingCredit = useAdminData(`ops:dl-credit:${reloadKey}`, (t) =>
    adminApi.deadLetters(t, "credit", { status: "WAITING", pageSize: 1 }),
  );
  const orderAlerts = useAdminData(`ops:order-alerts:${reloadKey}`, (t) => adminApi.operatorAlerts(t));
  const creditAlerts = useAdminData(`ops:credit-alerts:${reloadKey}`, (t) => adminApi.creditAlerts(t));

  // Both lists, newest first. One service not answering still shows the other's.
  const settled = (state: AdminData<unknown>) => state.data !== undefined || state.error !== undefined;
  const bothFailed = orderAlerts.error && creditAlerts.error;
  const merged: AdminData<Alert[]> = {
    loading: orderAlerts.loading || creditAlerts.loading,
    error: bothFailed ? orderAlerts.error : undefined,
    data:
      bothFailed || !settled(orderAlerts) || !settled(creditAlerts)
        ? undefined
        : [
            ...(orderAlerts.data?.items ?? []).map(
              (alert): Alert => ({ source: "Order", at: alert.raisedAt, orderId: alert.orderId, alert }),
            ),
            ...(creditAlerts.data?.items ?? []).map(
              (alert): Alert => ({ source: "Credit", at: alert.occurredAt, orderId: alert.orderId, alert }),
            ),
          ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    reload: () => {
      orderAlerts.reload();
      creditAlerts.reload();
    },
  };
  const missing = orderAlerts.error ?? creditAlerts.error;

  return (
    <>
      <div className={styles.stats}>
        <Stat
          href="#dead-letters"
          label="Dead letters waiting, Order"
          value={figure(waitingOrder, (d) => d.total)}
        />
        <Stat
          href="#dead-letters"
          label="Dead letters waiting, Credit"
          value={figure(waitingCredit, (d) => d.total)}
        />
        <Stat href="#alerts" label="Errand alerts" value={figure(orderAlerts, (d) => d.items.length)} />
        <Stat
          href="#alerts"
          label="Credit audit alerts"
          value={figure(creditAlerts, (d) => d.items.length)}
        />
      </div>

      <div id="alerts">
        <Section
          title="Alerts"
          description="Errands that waited too long for credits or that the two services disagree about, and requests the Credit Service refused as inconsistent. Newest first."
          actions={
            <Button variant="outline" onClick={merged.reload}>
              Refresh
            </Button>
          }
        >
          {missing && merged.data && (
            <p className={styles.muted}>
              {orderAlerts.error ? "The Order Service" : "The Credit Service"} didn&apos;t answer, so its
              alerts are missing: {missing.message}
            </p>
          )}
          <Loaded
            state={merged}
            label="alerts"
            isEmpty={(d) => d.length === 0}
            emptyTitle="No alerts"
            emptyText="Nothing has waited too long for credits, and both services agree."
          >
            {(d) => (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption className="srOnly">Alerts, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Service</th>
                      <th scope="col">Alert</th>
                      <th scope="col">Errand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.map((a) => (
                      <tr
                        key={
                          a.source === "Order"
                            ? `order:${a.orderId}:${a.alert.kind}`
                            : `credit:${a.alert.alertId}`
                        }
                      >
                        <td className={styles.nowrap}>{formatWhen(a.at)}</td>
                        <td>{a.source}</td>
                        <td>
                          {a.source === "Order" ? (
                            <Tag tone={a.alert.kind === "CREDIT_STATE_CONFLICT" ? "danger" : "warning"}>
                              {OPERATOR_ALERT_KINDS[a.alert.kind]}
                            </Tag>
                          ) : (
                            <>
                              <Tag tone="danger">{creditAlertLabel(a.alert.code)}</Tag>
                              <span className={styles.secondary}>
                                {a.alert.operationType} refused · {a.alert.correlationId}
                              </span>
                            </>
                          )}
                        </td>
                        <td>
                          <button type="button" className={styles.link} onClick={() => onTrace(a.orderId)}>
                            Trace {shortId(a.orderId)}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Loaded>
        </Section>
      </div>
    </>
  );
}
