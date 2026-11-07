import type { Metadata } from "next";

/**
 * This page's address carries the emailed token, which chooses the account's password (#309). With no
 * referrer, nothing the page loads or links to is sent that address, the app's own servers included.
 */
export const metadata: Metadata = { referrer: "no-referrer" };

export default function ActivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
