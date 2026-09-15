import type { Supplier } from "@/lib/types";
import styles from "./SupplierCard.module.css";

export function SupplierCard({ supplier }: { supplier: Supplier }) {
  return (
    <div className={`card ${styles.card}`}>
      <div className={styles.thumb} />
      <div className={styles.info}>
        <p className={styles.name}>{supplier.name}</p>
        <p className={styles.location}>{supplier.location}</p>
      </div>
      <div className={styles.meta}>
        <p className={styles.category}>{supplier.category}</p>
        <p className={styles.distance}>{supplier.distance}</p>
      </div>
    </div>
  );
}
