// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-11-08
// Scope: Implementation for "account screens on the real User Service" (USR-05, WEB-00).
// Author review: Anselm Long, Jonus Ho and Patrick Thomas reviewed the implementation for
//   correctness, ran it against the test suite, and checked that it fits our service boundaries
//   without fatal errors before committing.

import type { Metadata, Viewport } from "next";
import "@/styles/tokens.css";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { StoreProvider } from "@/lib/store";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { values } from "@/styles/tokens";

export const metadata: Metadata = {
  title: "Friend on Campus",
  description: "Campus errands, run by students.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "FoC",
  },
};

export const viewport: Viewport = {
  themeColor: values.color.primary,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <StoreProvider>{children}</StoreProvider>
        </AuthProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
