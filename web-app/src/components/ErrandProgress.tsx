// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-09
// Scope: Generated the initial implementation for the interface polish pass (errand progress track).
// Author review: Anselm Long fixed the findings of Jonus Ho's review in #404, with tests for the
//   track's rules, before merge.

"use client";

import { useState, type CSSProperties } from "react";
import type { OrderStatus } from "@/lib/order-api";
import type { Role } from "@/lib/order-actions";
import styles from "./ErrandProgress.module.css";

// The badge's words where a stop is one state. "Posted" stays: a request still waiting for credits
// sits there too, and it is not open yet.
const STOPS = ["Posted", "Accepted", "In transit", "Delivered", "Complete"] as const;

/**
 * How far along the usual route an errand is: the last stop it has reached. The states that leave
 * the route (cancelled, expired, not placed, with an administrator, returning credits) have none,
 * and their status wording says what happened instead.
 */
const REACHED: Partial<Record<OrderStatus, number>> = {
  PENDING_CREDIT: 0,
  OPEN: 0,
  ACCEPTED: 1,
  PICKED_UP: 2,
  DELIVERED: 3,
  COMPLETION_PENDING_CREDIT: 3,
  COMPLETED: 4,
};

const LAST = STOPS.length - 1;

/**
 * The errand's route, stop by stop. When a live update moves it on while the page is open, the rail
 * fills to the new stop; when it completes in front of its courier, the reward lands on the last
 * stop. Read on arrival, it is simply drawn where the errand is.
 */
export function ErrandProgress({ status, reward, role }: { status: OrderStatus; reward: number; role: Role }) {
  // Seen at mount, so only a completion that happens while the page is open is celebrated.
  const [firstSeen] = useState(status);
  const reached = REACHED[status];
  if (reached === undefined) return null;
  const complete = reached === LAST;
  const arrived = complete && firstSeen !== "COMPLETED";

  return (
    <ol
      // Safari drops list semantics from a list with `list-style: none`; the role keeps them.
      role="list"
      className={styles.track}
      aria-label="Errand progress"
      data-complete={complete || undefined}
      data-arrived={arrived || undefined}
      style={{ "--progress": reached / LAST } as CSSProperties}
    >
      {STOPS.map((stop, i) => {
        const state = i < reached || complete ? "done" : i === reached ? "current" : "next";
        return (
          <li key={stop} className={styles.stop} data-state={state} aria-current={i === reached && !complete ? "step" : undefined}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.label}>
              {stop}
              {state === "done" && <span className="srOnly">, done</span>}
              {state === "next" && <span className="srOnly">, not yet</span>}
            </span>
            {i === LAST && complete && role === "COURIER" && (
              <span className={styles.reward}>
                +{reward}
                <span className="srOnly"> {reward === 1 ? "credit" : "credits"} to you</span>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
