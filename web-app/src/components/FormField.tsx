"use client";

import type { ComponentProps, ReactNode } from "react";
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
 */
export function FormAlert({
  children,
  tone = "error",
}: {
  children?: ReactNode;
  tone?: "error" | "info" | "success";
}) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`${styles.alert} ${TONES[tone]}`}>
      {children}
    </div>
  );
}
