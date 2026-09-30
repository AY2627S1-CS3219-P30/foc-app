import type { ReactNode } from "react";
import styles from "./AuthCard.module.css";

/**
 * The frame for the signed-out account screens. One tree for every width: full-bleed on a phone, a
 * centred card from 768 px. (The app screens render separate mobile and desktop trees; a form must
 * not, or its ids, focus and typed input would be duplicated.)
 */
export function AuthCard({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <p className={styles.logo} aria-hidden="true">
          NUQueSt
        </p>
        <h1 className={styles.title}>{title}</h1>
        {intro && <div className={styles.intro}>{intro}</div>}
        {children}
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </main>
  );
}
