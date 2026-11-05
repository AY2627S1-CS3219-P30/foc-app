import type { ReactNode } from 'react';
import { AppBar } from './AppBar';
import { Sidebar, type NavItem } from './Sidebar';
import { TopBar } from './TopBar';
import styles from './ResponsiveShell.module.css';

/**
 * The app frame as one tree for every width (decisions.md W3): the phone app bar below 768 px, the
 * top bar and sidebar from there up. The children render once, so typed input survives a resize, ids
 * are never duplicated, and the page has one `<main>` and one `<h1>` (#367).
 */
export function ResponsiveShell({
  title,
  barTitle = title,
  navItems,
  activeHref,
  showCreditPill = true,
  logoText,
  onBack,
  onPlusClick,
  actions,
  children,
}: {
  title: string;
  /** The phone app bar's title, where it is shorter than the page's. */
  barTitle?: string;
  navItems: NavItem[];
  activeHref: string;
  showCreditPill?: boolean;
  /** The top bar's logo; the admin console's pages pass its own (`TopBar`'s default otherwise). */
  logoText?: string;
  onBack?: () => void;
  /** The app bar's `+`, the phone's form of `actions`. */
  onPlusClick?: () => void;
  /** Beside the heading, from 768 px. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <div className={styles.appBar}>
        <AppBar title={barTitle} onBack={onBack} onPlusClick={onPlusClick} />
      </div>
      <div className={styles.topBar}>
        <TopBar logoText={logoText} showCreditPill={showCreditPill} />
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
            {actions && <div className={styles.actions}>{actions}</div>}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
