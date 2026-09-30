import type { ComponentProps } from "react";
import { cx } from "@/lib/cx";
import styles from "./Button.module.css";

type Variant = "primary" | "accent" | "outline" | "subtle";

type Look = { variant?: Variant; full?: boolean };

/** The button look, for a `<Link>` that should read as a button. */
export function buttonClass({ variant = "primary", full }: Look = {}) {
  return cx(styles.button, styles[variant], full && styles.full);
}

export function Button({ variant, full, className, ...props }: Look & ComponentProps<"button">) {
  return <button className={cx(buttonClass({ variant, full }), className)} {...props} />;
}
