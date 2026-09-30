"use client";

import type { ComponentProps } from "react";
import { cx } from "@/lib/cx";
import { useFieldControl } from "./Field";
import styles from "./Control.module.css";

/** A range input that shows its current value. The input announces the value itself. */
export function Slider({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <span className={styles.slider}>
      <input
        type="range"
        {...useFieldControl(props)}
        className={cx(styles.range, className)}
      />
      {props.value !== undefined && (
        <span className={styles.value} aria-hidden="true">
          {props.value}
        </span>
      )}
    </span>
  );
}
