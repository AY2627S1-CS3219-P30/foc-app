import { useId, type InputHTMLAttributes } from "react";
import styles from "./FormField.module.css";

/**
 * A labelled input whose error is announced and tied to it (`aria-invalid` + `aria-describedby`), so
 * a screen reader hears which field failed and why. The value is controlled by the caller, so a
 * failed submit never clears what the user typed.
 */
export function FormField({
  label,
  error,
  hint,
  ...input
}: {
  label: string;
  error?: string;
  hint?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className={styles.field}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        id={id}
        className={`text-input ${error ? styles.invalid : ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}

const TONES = { error: styles.toneError, info: styles.toneInfo, success: styles.toneSuccess };

/** A form-level message. `role="alert"` so it is announced when it appears. */
export function FormAlert({
  children,
  tone = "error",
}: {
  children: React.ReactNode;
  tone?: "error" | "info" | "success";
}) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`${styles.alert} ${TONES[tone]}`}>
      {children}
    </div>
  );
}
