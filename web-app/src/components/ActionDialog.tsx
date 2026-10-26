"use client";

import { useEffect, useId, useRef } from "react";
import type { OrderActionState } from "@/lib/use-order-action";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { FormAlert } from "./FormField";
import styles from "./ActionDialog.module.css";

/** Confirms an errand command before it is sent. One that can't be undone opens on "Go back". */
export function ActionDialog({ state }: { state: OrderActionState }) {
  const { action, busy, error, close, confirm } = state;
  const bodyId = useId();
  const back = useRef<HTMLButtonElement>(null);
  const go = useRef<HTMLButtonElement>(null);

  // Here rather than `autoFocus`, which React runs before the dialog has opened.
  useEffect(() => {
    (action?.destructive ? back : go).current?.focus();
  }, [action]);

  return (
    <Dialog
      open={action !== null}
      title={action?.confirm.title ?? ""}
      describedBy={bodyId}
      onClose={close}
    >
      {action && (
        <div className={styles.body}>
          <p id={bodyId} className={styles.text}>{action.confirm.body}</p>
          <FormAlert>{error}</FormAlert>
          <div className={styles.actions}>
            <Button ref={back} type="button" variant="outline" onClick={close} disabled={busy}>
              Go back
            </Button>
            <Button ref={go} type="button" onClick={() => void confirm()} disabled={busy}>
              {busy ? "Working…" : action.confirm.label}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
