import type { NavItem } from "@/components/Sidebar";
import type { PreferredMode } from "./user-api";

export const STUDENT_NAV: NavItem[] = [
  { href: "/feed", label: "Request feed" },
  { href: "/suppliers", label: "Suppliers" },
  { href: "/wallet", label: "Wallet" },
  { href: "/order-history", label: "Order history" },
  { href: "/profile", label: "Profile" },
];

export const ADMIN_NAV: NavItem[] = [{ href: "/admin", label: "Overview" }];

/** The screen each mode leads with: requesters track their errands, couriers look for new ones. */
const LEADS: Record<PreferredMode, string> = {
  REQUESTER: "/order-history",
  COURIER: "/feed",
};

/**
 * Puts the current mode's leading screen first. Presentation only — both modes see every screen,
 * because every active student may both request and deliver (US-FR2.1.1).
 */
export function orderForMode<T extends { href: string }>(items: T[], mode?: PreferredMode): T[] {
  if (!mode) return items;
  const lead = items.find((i) => i.href === LEADS[mode]);
  return lead ? [lead, ...items.filter((i) => i !== lead)] : items;
}
