"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Field } from "@/components/Field";
import { FormAlert } from "@/components/FormField";
import { Textarea } from "@/components/Textarea";
import { ApiError } from "@/lib/api-client";
import styles from "./admin.module.css";

const MAX_REASON = 500;

/** What an admin is about to do; `null` keeps the dialog closed. */
export type PendingAction = {
  title: string;
  intro: ReactNode;
  confirmLabel: string;
  /** Runs the action with the reason given. Throw an `ApiError` to show it in the dialog. */
  run: (reason: string) => Promise<void>;
};

/**
 * Every admin write asks for a reason first: the services require one, and it is what the audit
 * trail shows. A failure stays in the dialog with the reason still typed.
 */
export function ReasonDialog({
  action,
  onClose,
}: {
  action: PendingAction | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={action !== null} title={action?.title ?? ""} onClose={onClose}>
      {action && <ReasonForm action={action} onCancel={onClose} />}
    </Dialog>
  );
}

function ReasonForm({ action, onCancel }: { action: PendingAction; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Give a reason. It is kept in the audit trail.");
      return;
    }
    setError(undefined);
    setProblem(null);
    setBusy(true);
    try {
      await action.run(trimmed);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className={styles.dialogForm}>
      <div className={styles.muted}>{action.intro}</div>
      <FormAlert>{problem}</FormAlert>
      <Field
        label="Reason"
        hint="Recorded in the audit trail with your name."
        error={error}
        required
      >
        <Textarea
          name="reason"
          maxLength={MAX_REASON}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
      </Field>
      <div className={styles.dialogActions}>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Working…" : action.confirmLabel}
        </Button>
      </div>
    </form>
  );
}
