"use client";

import type { ComponentProps } from "react";
import { cx } from "@/lib/cx";
import { useFieldControl } from "./Field";
import styles from "./Control.module.css";

/** A native `<select>`: pass `<option>`s as children. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className={styles.select}>
      <select {...useFieldControl(props)} className={cx(styles.control, className)} />
    </span>
  );
}
