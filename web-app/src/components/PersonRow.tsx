import styles from "./PersonRow.module.css";

export function PersonRow({ name, location }: { name: string; location: string }) {
  return (
    <div className={styles.row}>
      <div className={styles.avatar}>{name.charAt(0).toUpperCase()}</div>
      <div>
        <p className={styles.name}>{name}</p>
        <p className={styles.location}>{location}</p>
      </div>
    </div>
  );
}
