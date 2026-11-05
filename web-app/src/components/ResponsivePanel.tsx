import type { ReactNode } from "react";
import { ScreenHeader } from "./ScreenHeader";
import styles from "./ResponsivePanel.module.css";

/**
 * A page that is one panel with a back arrow, as one tree for every width: the whole screen on a
 * phone, and a card on the page from 768 px. It has one `<main>` and one `<h1>` (#367).
 */
export function ResponsivePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <ScreenHeader title={title} />
        <div className={styles.body}>{children}</div>
      </div>
    </main>
  );
}
