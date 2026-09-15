import styles from "./StatCard.module.css";

export function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={`card ${styles.card}`}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  );
}
