"use client";

import type { OrderActionState } from "@/lib/use-order-action";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { FormAlert } from "./FormField";
import styles from "./ActionDialog.module.css";

/** Confirms an errand command before it is sent. */
export function ActionDialog({ state }: { state: OrderActionState }) {
  const { action, busy, error, close, confirm } = state;
  return (
    <Dialog open={action !== null} title={action?.confirm.title ?? ""} onClose={close}>
      {action && (
        <div className={styles.body}>
          <p className={styles.text}>{action.confirm.body}</p>
          <FormAlert>{error}</FormAlert>
          <div className={styles.actions}>
            <Button type="button" variant="outline" onClick={close} disabled={busy}>
              Go back
            </Button>
            <Button type="button" onClick={() => void confirm()} disabled={busy} autoFocus>
              {busy ? "Working…" : action.confirm.label}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
