// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-11-05
// Scope: Generated the initial implementation for "harden account screens and sessions (PR #193
//   review)" (#193, WEB-00, SUP-04); later new features and bug fixes.
// Author review: Jonus Ho and Patrick Thomas validated the behaviour and the implementation,
//   checked for fatal errors, and confirmed it does not conflict with the architecture before
//   committing.

import type { ReactNode } from 'react';
import { AppBar } from './AppBar';
import { Button } from './Button';
import { Icon } from './Icon';
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
  navItems,
  activeHref,
  showCreditPill = true,
  logoText,
  onBack,
  primaryAction,
  children,
}: {
  title: string;
  navItems: NavItem[];
  activeHref: string;
  showCreditPill?: boolean;
  /** The top bar's logo; the admin console's pages pass its own (`TopBar`'s default otherwise). */
  logoText?: string;
  onBack?: () => void;
  /** The screen's main action: the app bar's `+` on a phone, a button by the heading from 768 px. */
  primaryAction?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <div className={styles.appBar}>
        <AppBar title={title} onBack={onBack} action={primaryAction} />
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
                <Icon name="back" />
              </button>
            )}
            <h1 className={styles.heading}>{title}</h1>
            {primaryAction && (
              <div className={styles.actions}>
                <Button onClick={primaryAction.onClick}>{primaryAction.label}</Button>
              </div>
            )}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
