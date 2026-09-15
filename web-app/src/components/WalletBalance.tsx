import styles from "./WalletBalance.module.css";

export function WalletBalance({
  available,
  reserved,
  earnedThisWeek,
}: {
  available: number;
  reserved: number;
  earnedThisWeek: number;
}) {
  return (
    <div className="card">
      <p className={styles.caption}>Available balance</p>
      <div className={styles.amount}>
        <span className={styles.number}>{available}</span>
        <span className={styles.unit}>credits</span>
      </div>
      <div className={styles.split}>
        <div>
          <p className={styles.splitLabel}>Reserved</p>
          <p className={styles.splitValue}>{reserved}</p>
        </div>
        <div>
          <p className={styles.splitLabel}>Earned this week</p>
          <p className={styles.splitValue}>+{earnedThisWeek}</p>
        </div>
      </div>
    </div>
  );
}
