"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./Dialog.module.css";

/**
 * A modal dialog on the native `<dialog>`: the browser keeps focus inside it, makes the page behind
 * it inert, and returns focus to whatever opened it. Escape calls `onClose`, so the caller stays in
 * charge of `open`. The content mounts only while open, so a form inside starts empty every time.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
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
