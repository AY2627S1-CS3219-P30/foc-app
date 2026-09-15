import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "accent" | "outline" | "subtle";

export function Button({
  variant = "primary",
  full,
  className,
  ...props
}: {
  variant?: Variant;
  full?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ["btn", `btn--${variant}`, full ? "btn--full" : "", className]
    .filter(Boolean)
    .join(" ");
  return <button className={classes} {...props} />;
}
