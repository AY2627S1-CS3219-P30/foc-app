import type { ReactNode } from "react";
import { Sidebar, type NavItem } from "./Sidebar";
import { TopBar } from "./TopBar";
import styles from "./DesktopShell.module.css";

export function DesktopShell({
  navItems,
  activeHref,
  logoText,
  showCreditPill = true,
  heading,
  actions,
  children,
}: {
  navItems: NavItem[];
  activeHref: string;
  logoText?: string;
  showCreditPill?: boolean;
  heading: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <TopBar logoText={logoText} showCreditPill={showCreditPill} />
      <div className={styles.body}>
        <Sidebar items={navItems} activeHref={activeHref} />
        <main className={styles.main}>
          <div className={styles.headingRow}>
            <h1 className={styles.heading}>{heading}</h1>
            {actions}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
