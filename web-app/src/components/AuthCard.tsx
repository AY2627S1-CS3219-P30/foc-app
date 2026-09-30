import type { ReactNode } from "react";
import { NOT_CONFIGURED_MESSAGE, USER_SERVICE_URL } from "@/lib/user-api";
import { FormAlert } from "./FormField";
import styles from "./AuthCard.module.css";

/**
 * The frame for the signed-out account screens. One tree for every width: full-bleed on a phone, a
 * centred card from 768 px. (The app screens render separate mobile and desktop trees; a form must
 * not, or its ids, focus and typed input would be duplicated.)
 *
 * A production build made without the User Service's address says so here, on every account screen.
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
        {USER_SERVICE_URL === null && <FormAlert>{NOT_CONFIGURED_MESSAGE}</FormAlert>}
        {intro && <div className={styles.intro}>{intro}</div>}
        {children}
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </main>
  );
}
