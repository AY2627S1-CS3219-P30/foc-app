"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { FormAlert } from "@/components/FormField";
import { Input } from "@/components/Input";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { adminApi, type OrderCreditTrace, type OrderTimeline } from "@/lib/admin-api";
import { formatInstant, isUuid } from "@/lib/admin-labels";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { errandTrace } from "@/lib/errand-trace";
import { Section, Tag, UserLink } from "../_components/ui";
import styles from "../_components/admin.module.css";

type Half<T> = { data?: T; error?: ApiError };
type Trace = { orderId: string; order: Half<OrderTimeline>; credit: Half<OrderCreditTrace> };

const settle = <T,>(promise: Promise<T>): Promise<Half<T>> =>
  promise.then(
    (data) => ({ data }),
    (err: unknown) => ({
      error: err instanceof ApiError ? err : new ApiError(0, "ERROR", "Something went wrong."),
    }),
  );

/**
 * PLT-05 (EI-NFR4.1.1) — one errand, from its ID, as both services recorded it: every state change,
 * every event sent or waiting, reconciliation, alerts and dead letters, in the order they happened.
 * `orderId` is the errand to show; the form, or a "Trace" elsewhere on the page, changes it.
 */
export function ErrandTrace({
  orderId,
  reloadKey,
  onTrace,
}: {
  orderId: string | null;
  reloadKey: number;
  onTrace: (orderId: string) => void;
}) {
  const { authed } = useAuth();
  const [text, setText] = useState(orderId ?? "");
  const [inputError, setInputError] = useState<string>();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [attempt, setAttempt] = useState(0);

  // A trace started elsewhere on the page fills the box too.
  const [shownFor, setShownFor] = useState(orderId);
  if (orderId !== shownFor) {
    setShownFor(orderId);
    if (orderId) setText(orderId);
  }

  useEffect(() => {
    if (!orderId) return;
    let live = true;
    // Each half answers on its own: a Credit Service that is down still leaves Order's story.
    Promise.all([
      settle(authed((t) => adminApi.orderTimeline(t, orderId))),
      settle(authed((t) => adminApi.orderCredit(t, orderId))),
    ]).then(([order, credit]) => live && setTrace({ orderId, order, credit }));
    return () => {
      live = false;
    };
  }, [authed, orderId, reloadKey, attempt]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const id = text.trim();
    if (!isUuid(id)) {
      setInputError("An errand ID is a UUID, like 0198a1c2-5b3e-7c11-9d4a-2f8b6e1a7c30.");
      return;
    }
    setInputError(undefined);
    if (id === orderId) setAttempt((n) => n + 1);
    else onTrace(id);
  }

  const current = trace && trace.orderId === orderId ? trace : null;

  return (
    <Section
      title="Trace an errand"
      description="Everything the Order and Credit services recorded about one errand, in the order it happened. Paste its ID, or choose “Trace” beside a dead letter or alert."
    >
      <form className={styles.filters} onSubmit={submit} role="search">
        <Field label="Errand ID" error={inputError}>
          <Input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={36}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Button type="submit">Trace</Button>
      </form>

      {!orderId ? null : !current ? (
        <LoadingState label="Tracing the errand…" rows={3} />
      ) : current.order.error?.status === 404 ? (
        <EmptyState title="No such errand">
          The Order Service has no errand with this ID.
          {current.credit.data && current.credit.data.operations.length > 0
            ? " The Credit Service has a record of it, shown below."
            : ""}
        </EmptyState>
      ) : current.order.error ? (
        <ErrorState title="Couldn't load the errand" onRetry={() => setAttempt((n) => n + 1)}>
          {current.order.error.message}
        </ErrorState>
      ) : (
        <TraceView trace={current} />
      )}
      {current?.credit.error && (
        <FormAlert>
          The Credit Service didn&apos;t answer ({current.credit.error.message}), so its half is missing.
        </FormAlert>
      )}
    </Section>
  );
}

function TraceView({ trace }: { trace: Trace }) {
  const order = trace.order.data;
  const entries = errandTrace(order, trace.credit.data);
  return (
    <>
      {order && (
        <dl className={styles.facts}>
          <dt>Status</dt>
          <dd>
            <Tag tone="info">{order.status}</Tag> version {order.version}
          </dd>
          <dt>Requester</dt>
          <dd>
            <UserLink id={order.requesterId} />
          </dd>
          <dt>Courier</dt>
          <dd>{order.courierId ? <UserLink id={order.courierId} /> : "None yet"}</dd>
          <dt>Reward</dt>
          <dd>{order.reward} credits</dd>
          <dt>Credit transaction</dt>
          <dd className={styles.mono}>{order.creditTransactionId ?? "None yet"}</dd>
        </dl>
      )}
      <ol className={styles.trace} aria-label="What happened, oldest first">
        {entries.map((entry, i) => (
          <li key={i} className={styles.traceItem}>
            <time className={styles.traceWhen} dateTime={entry.at}>
              {formatInstant(entry.at)}
            </time>
            <div className={styles.traceBody}>
              <div className={styles.tags}>
                <Tag tone={entry.source === "Order" ? "neutral" : "info"}>{entry.source}</Tag>
                <Tag tone={entry.tone}>{entry.title}</Tag>
              </div>
              {entry.detail && <span>{entry.detail}</span>}
              {entry.correlationId && (
                <span className={styles.secondary}>Correlation {entry.correlationId}</span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
