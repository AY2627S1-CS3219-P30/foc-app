import type { ReactNode } from 'react';
import { AppBar } from './AppBar';
import { Sidebar, type NavItem } from './Sidebar';
import { TopBar } from './TopBar';
import styles from './ResponsiveShell.module.css';

/**
 * The app frame as one tree for every width, for screens that hold a form (decisions.md W3): the
 * phone app bar below 768 px, the top bar and sidebar from there up. The children render once, so
 * typed input survives a resize and ids are never duplicated. (Screens without a form still render
 * separate `Screen` and `DesktopShell` trees and let CSS pick one.)
 */
export function ResponsiveShell({
  title,
  navItems,
  activeHref,
  showCreditPill = true,
  onBack,
  children,
}: {
  title: string;
  navItems: NavItem[];
  activeHref: string;
  showCreditPill?: boolean;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <div className={styles.appBar}>
        <AppBar title={title} onBack={onBack} />
      </div>
      <div className={styles.topBar}>
        <TopBar showCreditPill={showCreditPill} />
      </div>
      <div className={styles.body}>
        <div className={styles.sidebar}>
          <Sidebar items={navItems} activeHref={activeHref} />
        </div>
        <main className={styles.main}>
          <div className={styles.header}>
            {onBack && (
              <button className={styles.back} aria-label="Back" onClick={onBack}>
                ←
              </button>
            )}
            <h1 className={styles.heading}>{title}</h1>
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
