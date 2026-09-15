"use client";

import { useRouter } from "next/navigation";
import { Badge } from "./Badge";
import { Button } from "./Button";
import type { ErrandRequest } from "@/lib/types";
import styles from "./ErrandCard.module.css";

export function ErrandCard({
  request,
  onAccept,
}: {
  request: ErrandRequest;
  onAccept?: (id: string) => void;
}) {
  const router = useRouter();
  return (
    <div
      className={`card ${styles.card}`}
      onClick={() => router.push(`/request/${request.id}`)}
    >
      <div className={styles.meta}>
        <Badge status={request.status} />
        <span className={styles.expiry}>{request.expiryLabel}</span>
      </div>
      <div className={styles.route}>
        <p className={styles.title}>{request.title}</p>
        <p className={styles.dropoff}>{request.dropoff}</p>
      </div>
      <div className={styles.action}>
        <div className={styles.reward}>
          <strong>{request.credits}</strong>
          <span>credits</span>
        </div>
        {onAccept && request.status === "open" && (
          <Button
            variant="accent"
            onClick={(e) => {
              e.stopPropagation();
              onAccept(request.id);
              router.push(`/request/${request.id}`);
            }}
          >
            Accept
          </Button>
        )}
      </div>
    </div>
  );
}
