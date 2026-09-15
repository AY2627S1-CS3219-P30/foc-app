import styles from "./CreditSlider.module.css";

export function CreditSlider({
  value,
  onChange,
  min = 1,
  max = 30,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <div className={styles.row}>
        <span className="field-label">Credits</span>
        <span className={styles.value}>{value}</span>
      </div>
      <input
        type="range"
        className={styles.slider}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className={styles.desc}>How many credits will you offer for this errand?</p>
    </div>
  );
}
