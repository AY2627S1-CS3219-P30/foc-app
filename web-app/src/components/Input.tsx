"use client";

import type { ComponentProps } from "react";
import { cx } from "@/lib/cx";
import { useFieldControl } from "./Field";
import styles from "./Control.module.css";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...useFieldControl(props)} className={cx(styles.control, className)} />;
}
