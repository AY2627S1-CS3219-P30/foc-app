// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-09
// Scope: Generated the initial implementation for the interface polish pass (drawn icons in place of
//   text glyphs).
// Author review: Jonus Ho reviewed it in #404, and Anselm Long addressed the review, before merge.

import type { SVGProps } from "react";

const PATHS = {
  back: "M19 12H5m6-7-7 7 7 7",
  menu: "M4 7h16M4 12h16M4 17h16",
  plus: "M12 5v14M5 12h14",
} as const;

/**
 * The app's few icons, drawn in one stroke so they sit together and take `currentColor`. Always
 * decorative: the control that holds one carries the accessible name.
 */
export function Icon({ name, ...props }: { name: keyof typeof PATHS } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
