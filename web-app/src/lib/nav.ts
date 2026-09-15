import type { NavItem } from "@/components/Sidebar";

export const STUDENT_NAV: NavItem[] = [
  { href: "/feed", label: "Request feed" },
  { href: "/suppliers", label: "Suppliers" },
  { href: "/wallet", label: "Wallet" },
  { href: "/order-history", label: "Order history" },
  { href: "/profile", label: "Profile" },
];

export const ADMIN_NAV: NavItem[] = [{ href: "/admin", label: "Overview" }];
