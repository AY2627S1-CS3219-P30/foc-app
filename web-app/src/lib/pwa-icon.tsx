// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-11-08
// Scope: Implementation for "rename the app from NUQueSt to Friend on Campus" (WEB-00).
// Author review: Jonus Ho and Patrick Thomas validated the behaviour and the implementation,
//   checked for fatal errors, and confirmed it does not conflict with the architecture before
//   committing.

import type { CSSProperties } from "react";
import { values } from "@/styles/tokens";

export function iconMarkup(size: number): { style: CSSProperties; children: string } {
  return {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: values.color.primary,
      color: values.color.onPrimary,
      fontSize: size * 0.55,
      fontWeight: Number(values.weight.bold),
      fontFamily: "system-ui, sans-serif",
    },
    children: "F",
  };
}
