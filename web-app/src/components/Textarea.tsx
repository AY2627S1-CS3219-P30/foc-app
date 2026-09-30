"use client";

import type { ComponentProps } from "react";
import { cx } from "@/lib/cx";
import { useFieldControl } from "./Field";
import styles from "./Control.module.css";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      {...useFieldControl(props)}
      className={cx(styles.control, styles.textarea, className)}
    />
  );
}
