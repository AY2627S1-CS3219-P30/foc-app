"use client";

import { createContext, use, useId, type ComponentProps, type ReactNode } from "react";
import styles from "./Field.module.css";

type Control = {
  id: string;
  required?: boolean;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
};

type ControlProps = {
  id?: string;
  required?: boolean;
  "aria-invalid"?: ComponentProps<"input">["aria-invalid"];
  "aria-describedby"?: string;
};

const FieldContext = createContext<Control | null>(null);

const joinIds = (...ids: (string | undefined)[]) => ids.filter(Boolean).join(" ") || undefined;

/**
 * Wires its control (`Input`, `Select`, `Textarea`, `Slider`) to the label, hint and error, so a
 * screen reader hears which field failed and why. The Field owns the id, so set it on the Field;
 * the control's own `aria-describedby` is kept alongside the hint and error.
 */
export function useFieldControl<P extends ControlProps>(props: P): P {
  const field = use(FieldContext);
  if (!field) return props;
  return {
    ...props,
    id: field.id,
    required: props.required ?? field.required,
    "aria-invalid": field["aria-invalid"] ?? props["aria-invalid"],
    "aria-describedby": joinIds(field["aria-describedby"], props["aria-describedby"]),
  };
}

export function Field({
  id: fieldId,
  label,
  hint,
  error,
  required,
  children,
}: {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  const generatedId = useId();
  const id = fieldId ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const control: Control = {
    id,
    required: required || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": joinIds(hint ? hintId : undefined, error ? errorId : undefined),
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
