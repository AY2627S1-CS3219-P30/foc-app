// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-10-21
// Scope: Bug fixes, including "share one credit balance and steady focus around errand commands".
// Author review: Patrick Thomas checked the code for correctness against the ticket, confirmed the
//   tests pass, and made sure it caused no fatal errors or architectural conflicts before
//   committing.

"use client";

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import styles from "./Dialog.module.css";

/**
 * A modal dialog on the native `<dialog>`: the browser keeps focus inside it, makes the page behind
 * it inert, and returns focus to whatever opened it. Escape calls `onClose`, so the caller stays in
 * charge of `open`. The content mounts only while open, so a form inside starts empty every time.
 * It opens and closes before effects run, so theirs can move focus into it or back onto the page.
 */
export function Dialog({
  open,
  title,
  describedBy,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  /** The id of the content's explanation, read out with the title. */
  describedBy?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {children}
        </>
      )}
    </dialog>
  );
}
