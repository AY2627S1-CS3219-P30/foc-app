import type { NavItem } from "@/components/Sidebar";
import type { PreferredMode } from "./user-api";

export const STUDENT_NAV: NavItem[] = [
  { href: "/feed", label: "Request feed" },
  { href: "/suppliers", label: "Suppliers" },
  { href: "/wallet", label: "Wallet" },
  { href: "/order-history", label: "Order history" },
  { href: "/profile", label: "Profile" },
];

/** The admin console (ADM-02). Every page calls endpoints that refuse a non-admin on their own. */
export const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/role-requests", label: "Role requests" },
  { href: "/admin/audit", label: "Audit trail" },
  { href: "/admin/activity", label: "Admin activity" },
  { href: "/admin/errands", label: "Errands" },
  { href: "/admin/wallets", label: "Wallets" },
  { href: "/admin/operations", label: "Operations" },
];

const ADMIN_ENTRY: NavItem = { href: "/admin", label: "Admin console" };

/**
 * Adds the console to a student navigation, for administrators only. Presentation: a student who
 * visits `/admin` anyway is told it is not for them, and every admin endpoint refuses them.
 */
export function withAdminEntry<T extends NavItem>(
  items: T[],
  roles: readonly string[] | undefined,
): (T | NavItem)[] {
  if (!roles?.includes("ADMIN") || items.some((i) => i.href === ADMIN_ENTRY.href)) return items;
  return [...items, ADMIN_ENTRY];
}

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
