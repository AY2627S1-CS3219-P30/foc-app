"use client";

import { useId, useState, type ComponentProps } from "react";
import { cx } from "@/lib/cx";
import { useFieldControl } from "./Field";
import styles from "./Control.module.css";

type SliderProps = Omit<ComponentProps<"input">, "type">;

/** Where a range input with no value starts: halfway between min and max, snapped to the step. */
function midpoint({ min = 0, max = 100, step = 1 }: SliderProps) {
  const [lo, hi, by] = [Number(min), Number(max), Number(step) || 1];
  return hi < lo ? lo : lo + Math.round((hi - lo) / 2 / by) * by;
}

/**
 * A range input that shows its current value, controlled or not. The readout is an `<output>` for
 * the input but not a live region, since the input already announces its value.
 */
export function Slider({ className, onChange, ...props }: SliderProps) {
  const control = useFieldControl(props);
  const fallbackId = useId();
  const id = control.id ?? fallbackId;
  const [initial] = useState(() => props.defaultValue ?? midpoint(props));
  const [uncontrolled, setUncontrolled] = useState(initial);
  const value = props.value ?? uncontrolled;

  return (
    <span className={styles.slider}>
      <input
        type="range"
        {...control}
        id={id}
        defaultValue={props.value === undefined ? initial : undefined}
        onChange={(e) => {
          setUncontrolled(e.target.value);
          onChange?.(e);
        }}
        className={cx(styles.range, className)}
      />
      <output htmlFor={id} aria-live="off" className={styles.value}>
        {value}
      </output>
    </span>
  );
}
