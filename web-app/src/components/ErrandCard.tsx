"use client";

import Link from "next/link";
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
    // A real <Link>, not a <div onClick>, so the card is reachable and
    // activatable by keyboard and announced correctly by screen readers.
    <Link href={`/request/${request.id}`} className={`card ${styles.card}`}>
      <div className={styles.meta}>
        <Badge status={request.status} />
        <span className={styles.expiry}>{request.expiryLabel}</span>
      </div>
      <div className={styles.route}>
        <p className={styles.title}>{request.title}</p>
        <p className={styles.dropoff}>{request.dropoff}</p>
        <p className={styles.requester}>Posted by {request.requesterName}</p>
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
              e.preventDefault();
              e.stopPropagation();
              onAccept(request.id);
              router.push(`/request/${request.id}`);
            }}
          >
            Accept
          </Button>
        )}
      </div>
    </Link>
  );
}
