"use client";

import { createContext, use, useId, type ReactNode } from "react";
import styles from "./Field.module.css";

type Control = {
  id: string;
  required?: boolean;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
};

const FieldContext = createContext<Control | null>(null);

/**
 * Wires its control (`Input`, `Select`, `Textarea`, `Slider`) to the label, hint and error, so a
 * screen reader hears which field failed and why. Props set on the control itself win.
 */
export function useFieldControl<P extends object>(props: P): P & Partial<Control> {
  const field = use(FieldContext);
  return field ? { ...field, ...props } : props;
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(" ");
  const control: Control = {
    id,
    required: required || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy || undefined,
  };

  return (
    <div className={styles.field}>
      <label htmlFor={id} className="field-label">
        {label}
        {required && (
          <span className={styles.required} aria-hidden="true">
            {" *"}
          </span>
        )}
      </label>
      <FieldContext value={control}>{children}</FieldContext>
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
