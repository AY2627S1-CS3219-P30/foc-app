import type { ReactNode } from "react";
import styles from "./Screen.module.css";

export function Screen({ children }: { children: ReactNode }) {
  return <div className={styles.screen}>{children}</div>;
}

export function ScreenContent({ children }: { children: ReactNode }) {
  return <div className={styles.content}>{children}</div>;
}
