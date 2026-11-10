// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-11-08
// Scope: Implementation for "rename the app from NUQueSt to Friend on Campus" (WEB-00).
// Author review: Jonus Ho and Patrick Thomas validated correctness and the implementation, and
//   checked for fatal errors and architectural conflicts, before committing.

import type { MetadataRoute } from "next";
import { values } from "@/styles/tokens";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Friend on Campus",
    short_name: "FoC",
    description: "Campus errands, run by students.",
    start_url: "/",
    display: "standalone",
    background_color: values.color.surface,
    theme_color: values.color.primary,
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
