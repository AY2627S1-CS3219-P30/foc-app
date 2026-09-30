"use client";

import { useId, useState } from "react";
import { useAuth } from "@/lib/auth";
import type { PreferredMode } from "@/lib/user-api";
import styles from "./ModeSwitch.module.css";

const OPTIONS: { value: PreferredMode; label: string }[] = [
  { value: "REQUESTER", label: "Requester" },
  { value: "COURIER", label: "Courier" },
];

/**
 * The requester↔courier switch (USR-03 / US-FR2.1.2). It changes which screens lead, and is saved
 * as `preferredMode` so it follows the student across devices. It is a preference only: every
 * active student may request and deliver, and no server decision ever reads it.
 */
export function ModeSwitch() {
  const { user, setMode } = useAuth();
  const name = useId();
  const [error, setError] = useState<string | null>(null);
  if (!user) return null;
  const current = user.profile.preferredMode;

  async function choose(mode: PreferredMode) {
    if (mode === current) return;
    setError(null);
    try {
      await setMode(mode);
    } catch {
      setError("Couldn't switch. Try again.");
    }
  }

  return (
    <fieldset className={styles.switch}>
      <legend className={styles.legend}>Mode</legend>
      <div className={styles.options}>
        {OPTIONS.map((o) => {
          const id = `${name}-${o.value}`;
          return (
            <span key={o.value} className={styles.option}>
              <input
                type="radio"
                id={id}
                name={name}
                value={o.value}
                checked={current === o.value}
                onChange={() => void choose(o.value)}
                className={styles.input}
              />
              <label htmlFor={id} className={styles.label}>
                {o.label}
              </label>
            </span>
          );
        })}
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </fieldset>
  );
}
