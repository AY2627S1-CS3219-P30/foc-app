"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Field } from "@/components/Field";
import { FilterChip } from "@/components/FilterChip";
import { FormAlert } from "@/components/FormField";
import { Input } from "@/components/Input";
import { Select } from "@/components/Select";
import { ErrorState, LoadingState } from "@/components/States";
import {
  adminApi,
  type DeadLetter,
  type DeadLetterDetail,
  type DeadLetterQuery,
  type DeadLetterService,
  type DeadLetterStatus,
} from "@/lib/admin-api";
import { formatWhen, isUuid, shortId } from "@/lib/admin-labels";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { ReasonDialog, type PendingAction } from "../_components/ReasonDialog";
import { Loaded, Pager, Section, Tag, UserLink } from "../_components/ui";
import { useAdminData } from "../_components/use-admin-data";
import styles from "../_components/admin.module.css";

const PAGE_SIZE = 20;

export const SERVICES: Record<DeadLetterService, string> = {
  order: "Order Service",
  credit: "Credit Service",
};

/** What each service consumes, so an operator knows where to look. */
const CONSUMES: Record<DeadLetterService, string> = {
  order: "the Credit Service's replies: reserved, rejected, transferred and released credits",
  credit: "user.activated (a new student's wallet) and the Order Service's credit requests",
};

/**
 * PLT-05 (EI-FR3.1.2) — each service's dead letters: find one by correlation ID or errand, read what
 * it carried and why it failed, and redrive it unchanged. A redrive is the only change made here.
 */
export function DeadLetters({
  onTrace,
  onRedriven,
}: {
  onTrace: (orderId: string) => void;
  onRedriven: () => void;
}) {
  const { authed } = useAuth();
  const [service, setService] = useState<DeadLetterService>("order");
  const [text, setText] = useState("");
  const [status, setStatus] = useState<DeadLetterStatus | "">("WAITING");
  const [query, setQuery] = useState<DeadLetterQuery>({
    status: "WAITING",
    page: 1,
    pageSize: PAGE_SIZE,
  });
  const [inspecting, setInspecting] = useState<DeadLetter | null>(null);
  const [action, setAction] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const letters = useAdminData(`dead-letters:${service}:${JSON.stringify(query)}`, (t) =>
    adminApi.deadLetters(t, service, query),
  );

  function search(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    setQuery({ page: 1, pageSize: PAGE_SIZE, q: text.trim() || undefined, status: status || undefined });
  }

  const redrive = (letter: DeadLetter) =>
    setAction({
      title: "Redrive this dead letter?",
      intro: (
        <>
          <p>
            Sends {letter.eventType ?? "the message"} back to <code>{letter.queue}</code> exactly as
            it arrived. Its consumer decides again as if it had just come in: if it was already
            handled, nothing changes; if it fails again, it comes back here as a new dead letter.
          </p>
          <p>Fix what made it fail first. The message itself can&apos;t be edited.</p>
        </>
      ),
      confirmLabel: "Redrive",
      run: async (reason) => {
        await authed((t) => adminApi.redrive(t, service, letter.id, reason));
        setAction(null);
        setInspecting(null);
        setNotice(
          `Redriven to ${letter.queue}. It is recorded with your reason; follow the errand's trace to see it handled.`,
        );
        letters.reload();
        onRedriven();
      },
    });

  return (
    <Section
      title="Dead letters"
      description={
        <>
          Events a service could not handle after every retry, kept until an operator redrives them.
          The {SERVICES[service]} consumes {CONSUMES[service]}.
        </>
      }
      actions={
        <Button variant="outline" onClick={letters.reload}>
          Refresh
        </Button>
      }
    >
      <div className={styles.chips} role="group" aria-label="Service">
        {(Object.keys(SERVICES) as DeadLetterService[]).map((s) => (
          <FilterChip
            key={s}
            label={SERVICES[s]}
            selected={service === s}
            onClick={() => {
              setService(s);
              setQuery((q) => ({ ...q, page: 1 }));
              setNotice(null);
            }}
          />
        ))}
      </div>
      <form className={styles.filters} onSubmit={search} role="search">
        <Field label="Correlation, errand or event ID" hint="Matched exactly.">
          <Input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
            spellCheck={false}
          />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as DeadLetterStatus | "")}>
            <option value="WAITING">Waiting</option>
            <option value="REDRIVEN">Redriven</option>
            <option value="">Any status</option>
          </Select>
        </Field>
        <Button type="submit">Search</Button>
      </form>
      <FormAlert tone="success">{notice}</FormAlert>

      <Loaded
        state={letters}
        label="dead letters"
        isEmpty={(d) => d.items.length === 0}
        emptyTitle={query.q ? "No dead letters match" : "No dead letters"}
        emptyText={
          query.q
            ? "Nothing with that correlation, errand or event ID. IDs are matched exactly."
            : query.status === "WAITING"
              ? `Every event the ${SERVICES[service]} received was handled.`
              : "Nothing here yet."
        }
      >
        {(d) => (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="srOnly">
                  {SERVICES[service]} dead letters, {d.total} in all, newest first
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Parked</th>
                    <th scope="col">Event</th>
                    <th scope="col">About</th>
                    <th scope="col">Why it failed</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="srOnly">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((letter) => (
                    <tr key={letter.id}>
                      <td className={styles.nowrap}>{formatWhen(letter.parkedAt)}</td>
                      <td>
                        {letter.eventType ?? "Unreadable message"}
                        <span className={styles.secondary}>{letter.queue}</span>
                      </td>
                      <td>
                        <About letter={letter} onTrace={onTrace} />
                      </td>
                      <td>
                        {letter.failureReason ?? "No reason recorded"}
                        <span className={styles.secondary}>
                          after {letter.attempts} attempt{letter.attempts === 1 ? "" : "s"}
                        </span>
                      </td>
                      <td>
                        <StatusTag letter={letter} />
                      </td>
                      <td>
                        <div className={styles.actions}>
                          <Button variant="outline" onClick={() => setInspecting(letter)}>
                            Inspect
                          </Button>
                          {letter.status === "WAITING" && (
                            <Button onClick={() => redrive(letter)}>Redrive</Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={d.page}
              pageSize={d.pageSize}
              total={d.total}
              onPage={(page) => setQuery((q) => ({ ...q, page }))}
            />
          </>
        )}
      </Loaded>

      <Dialog
        open={inspecting !== null && action === null}
        title="Dead letter"
        onClose={() => setInspecting(null)}
      >
        {inspecting && (
          <Inspect
            service={service}
            letter={inspecting}
            onTrace={(id) => {
              setInspecting(null);
              onTrace(id);
            }}
            onRedrive={() => redrive(inspecting)}
            onClose={() => setInspecting(null)}
          />
        )}
      </Dialog>
      <ReasonDialog action={action} onClose={() => setAction(null)} />
    </Section>
  );
}

function StatusTag({ letter }: { letter: DeadLetter }) {
  return letter.status === "WAITING" ? (
    <Tag tone="danger">Waiting</Tag>
  ) : (
    <Tag tone="success">Redriven</Tag>
  );
}

/** The errand or account the event is about, and its correlation ID. */
function About({ letter, onTrace }: { letter: DeadLetter; onTrace: (orderId: string) => void }) {
  const wallet = letter.eventType === "user.activated";
  return (
    <>
      {letter.aggregateId === null ? (
        <span className={styles.muted}>Unknown</span>
      ) : wallet ? (
        <UserLink id={letter.aggregateId} />
      ) : isUuid(letter.aggregateId) ? (
        <button type="button" className={styles.link} onClick={() => onTrace(letter.aggregateId!)}>
          Errand {shortId(letter.aggregateId)}
        </button>
      ) : (
        <span className={styles.mono}>{letter.aggregateId}</span>
      )}
      {letter.correlationId && (
        <span className={styles.secondary} title="Correlation ID">
          {letter.correlationId}
        </span>
      )}
    </>
  );
}

/** Everything kept about one dead letter, read-only. */
function Inspect({
  service,
  letter,
  onTrace,
  onRedrive,
  onClose,
}: {
  service: DeadLetterService;
  letter: DeadLetter;
  onTrace: (orderId: string) => void;
  onRedrive: () => void;
  onClose: () => void;
}) {
  const { authed } = useAuth();
  const [detail, setDetail] = useState<DeadLetterDetail>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    authed((t) => adminApi.deadLetter(t, service, letter.id)).then(
      (d) => live && setDetail(d),
      (err: unknown) =>
        live &&
        setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again."),
    );
    return () => {
      live = false;
    };
  }, [authed, service, letter.id, attempt]);

  const traceable = letter.aggregateId && letter.eventType !== "user.activated" && isUuid(letter.aggregateId);

  return (
    <div className={styles.dialogForm}>
      <dl className={styles.facts}>
        <dt>Service</dt>
        <dd>{SERVICES[service]}</dd>
        <dt>Queue</dt>
        <dd className={styles.mono}>{letter.queue}</dd>
        <dt>Event</dt>
        <dd>
          {letter.eventType ?? "Unreadable message"}
          <span className={styles.secondary}>{letter.eventId ?? "No event ID"}</span>
        </dd>
        <dt>About</dt>
        <dd className={styles.mono}>{letter.aggregateId ?? "Unknown"}</dd>
        <dt>Correlation ID</dt>
        <dd className={styles.mono}>{letter.correlationId ?? "None"}</dd>
        <dt>Why it failed</dt>
        <dd>
          {letter.failureReason ?? "No reason recorded"}
          <span className={styles.secondary}>
            after {letter.attempts} attempt{letter.attempts === 1 ? "" : "s"}
          </span>
        </dd>
        <dt>Parked</dt>
        <dd>{formatWhen(letter.parkedAt)}</dd>
        <dt>Status</dt>
        <dd>
          <StatusTag letter={letter} />
          {letter.redrivenAt && (
            <span className={styles.secondary}>
              {formatWhen(letter.redrivenAt)} by <UserLink id={letter.redrivenBy} />:{" "}
              {letter.redriveReason}
            </span>
          )}
        </dd>
      </dl>
      {error ? (
        <ErrorState title="Couldn't load the message" onRetry={() => { setError(undefined); setAttempt((n) => n + 1); }}>
          {error}
        </ErrorState>
      ) : !detail ? (
        <LoadingState label="Loading the message…" rows={2} />
      ) : (
        <>
          <h3 className={styles.subTitle}>Message, as it arrived</h3>
          <pre className={styles.code}>
            {typeof detail.body === "string" ? detail.body : JSON.stringify(detail.body, null, 2)}
          </pre>
          <h3 className={styles.subTitle}>Headers</h3>
          <pre className={styles.code}>{JSON.stringify(detail.headers, null, 2)}</pre>
        </>
      )}
      <div className={styles.dialogActions}>
        {traceable && (
          <Button variant="outline" onClick={() => onTrace(letter.aggregateId!)}>
            Trace the errand
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        {letter.status === "WAITING" && <Button onClick={onRedrive}>Redrive…</Button>}
      </div>
    </div>
  );
}
