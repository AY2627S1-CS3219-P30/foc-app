import type { Metadata } from "next";

/** As for the activation page: the address carries the emailed token, so it is sent as no one's referrer. */
export const metadata: Metadata = { referrer: "no-referrer" };

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
