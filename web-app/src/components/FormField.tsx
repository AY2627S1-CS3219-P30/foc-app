"use client";

import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { Field } from "./Field";
import { Input } from "./Input";
import styles from "./FormField.module.css";

/**
 * A labelled text input: shorthand for `<Field><Input /></Field>`. The value is controlled by the
 * caller, so a failed submit never clears what the user typed.
 */
export function FormField({
  label,
  error,
  hint,
  id,
  ...input
}: {
  label: ReactNode;
  error?: string;
  hint?: string;
} & ComponentProps<"input">) {
  return (
    <Field id={id} label={label} error={error} hint={hint} required={input.required}>
      <Input {...input} />
    </Field>
  );
}

const TONES = { error: styles.toneError, info: styles.toneInfo, success: styles.toneSuccess };

/**
 * A form-level message in a live region (`alert` for errors, `status` otherwise). Keep it mounted and
 * change its children: a region that appears already holding its text is often not announced. Empty,
 * it takes no space. Use one per tone, since changing a region's role is announced unreliably.
 *
 * `takeFocus` moves focus to it each time its text changes to a message, for one about a control
 * that may be gone.
 */
export function FormAlert({
  children,
  tone = "error",
  takeFocus = false,
}: {
  children?: ReactNode;
  tone?: "error" | "info" | "success";
  takeFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (takeFocus && children) ref.current?.focus();
  }, [takeFocus, children]);
  return (
    <div
      ref={ref}
      role={tone === "error" ? "alert" : "status"}
      tabIndex={takeFocus ? -1 : undefined}
      className={`${styles.alert} ${TONES[tone]}`}
    >
      {children}
    </div>
  );
}
