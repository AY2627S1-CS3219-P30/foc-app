import type { Wallet } from "@/lib/order-api";
import styles from "./WalletBalance.module.css";

export function WalletBalance({ wallet }: { wallet: Pick<Wallet, "available" | "reserved" | "total"> }) {
  return (
    <div className="card">
      <p className={styles.caption}>Available</p>
      <div className={styles.amount}>
        <span className={styles.number}>{wallet.available}</span>
        <span className={styles.unit}>credits</span>
      </div>
      <div className={styles.split}>
        <div>
          <p className={styles.splitLabel}>Reserved for your errands</p>
          <p className={styles.splitValue}>{wallet.reserved}</p>
        </div>
        <div>
          <p className={styles.splitLabel}>Total</p>
          <p className={styles.splitValue}>{wallet.total}</p>
        </div>
      </div>
    </div>
  );
}
