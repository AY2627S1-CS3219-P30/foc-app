import type { LedgerEntry, LedgerType } from "@/lib/types";
import { vars } from "@/styles/tokens";
import styles from "./LedgerRow.module.css";

const DOT_COLOR: Record<LedgerType, string> = {
  earned: vars.color.success,
  spent: vars.color.danger,
  reserved: vars.color.warning,
  released: vars.color.info,
};

export function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const positive = entry.amount > 0;
  return (
    <div className={styles.row}>
      <span className={styles.dot} style={{ background: DOT_COLOR[entry.type] }} />
      <div className={styles.info}>
        <p className={styles.label}>{entry.label}</p>
        <p className={styles.detail}>{entry.detail}</p>
      </div>
      <span className={`${styles.amount} ${positive ? styles.positive : ""}`}>
        {positive ? "+" : ""}
        {entry.amount}
      </span>
    </div>
  );
}
