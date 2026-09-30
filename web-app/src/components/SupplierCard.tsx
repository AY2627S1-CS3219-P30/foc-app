'use client';

import { useState } from 'react';
import { Button } from './Button';
import type { Supplier } from '@/lib/supplier-api';
import { displayImageUrl, hoursLabel, TYPE_LABELS } from '@/lib/supplier-display';
import styles from './SupplierCard.module.css';

export function SupplierCard({
  supplier,
  admin,
  onEdit,
  onDelete,
}: {
  supplier: Supplier;
  admin?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const image = displayImageUrl(supplier.imageUrl);

  return (
    <article className={`card ${styles.card}`}>
      <div className={styles.thumb}>
        {image && !imageFailed ? (
          // The supplier API supplies arbitrary HTTPS hosts, so a plain image avoids a host allowlist.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={`Location of ${supplier.name}`}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span role="img" aria-label="No location image available">
            Image unavailable
          </span>
        )}
      </div>
      <div className={styles.info}>
        <h2 className={styles.name}>{supplier.name}</h2>
        <p className={styles.meta}>
          {TYPE_LABELS[supplier.type]} · {supplier.building}, floor {supplier.floor}
        </p>
        <p>{supplier.locationDescription}</p>
        <p className={styles.hours}>{hoursLabel(supplier.openingHours)}</p>
        <div className={styles.actions}>
          <Button
            variant="subtle"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? 'Hide details' : 'View details'}
          </Button>
          {admin && (
            <>
              <Button variant="outline" onClick={onEdit}>
                Edit
              </Button>
              <Button variant="outline" onClick={onDelete}>
                Delete
              </Button>
            </>
          )}
        </div>
        {expanded && (
          <div className={styles.details}>
            <p>
              <strong>Location:</strong> {supplier.building}, floor {supplier.floor} —{' '}
              {supplier.locationDescription}
            </p>
            <p>
              <strong>Opening hours:</strong> {hoursLabel(supplier.openingHours)}
            </p>
            {supplier.tags?.length ? (
              <p>
                <strong>Tags:</strong> {supplier.tags.join(', ')}
              </p>
            ) : null}
            {supplier.latitude !== null && supplier.longitude !== null && (
              <a
                href={`https://www.google.com/maps?q=${supplier.latitude},${supplier.longitude}`}
                target="_blank"
                rel="noreferrer"
              >
                Open map
              </a>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
