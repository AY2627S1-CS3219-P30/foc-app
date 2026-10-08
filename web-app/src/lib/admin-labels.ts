import type {
  AccountStatus,
  AdminAlert,
  AdminAlertKind,
  AuditAction,
  ReconciliationAttempt,
  RoleRequestStatus,
} from "./admin-api";

/** How the console names each audit action. */
export const AUDIT_ACTIONS: Record<AuditAction, string> = {
  SUSPEND: "Suspended",
  REACTIVATE: "Reactivated",
  ROLE_GRANT: "Made an administrator",
  ROLE_REVOKE: "Administrator role removed",
  ROLE_CHANGE_REQUESTED: "Role change requested",
  ROLE_CHANGE_REJECTED: "Role change rejected",
  ADMIN_BOOTSTRAP: "Bootstrapped as administrator",
};

export const ALERT_KINDS: Record<AdminAlertKind, string> = {
  ROLE_CHANGE: "Role change",
  ADMIN_SUSPENDED: "Administrator suspended",
  BULK_SUSPENSIONS: "Many suspensions",
  SUSPENSION_LIMIT_REACHED: "Suspension limit reached",
  BULK_READS: "Many accounts opened",
};

export const ACCOUNT_STATUSES: Record<AccountStatus, string> = {
  PENDING_ACTIVATION: "Not activated",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
};

export const REQUEST_STATUSES: Record<RoleRequestStatus, string> = {
  PENDING: "Waiting for approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
};

export const RECONCILIATION_ACTIONS: Record<ReconciliationAttempt["action"], string> = {
  REISSUED: "Request sent again",
  ALERTED: "Contradiction raised",
  CREDIT_UNAVAILABLE: "Credit Service unreachable",
};

/** The colour family a status reads as. Always shown with its words, never by colour alone. */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const AUDIT_TONES: Record<AuditAction, Tone> = {
  SUSPEND: "danger",
  REACTIVATE: "success",
  ROLE_GRANT: "info",
  ROLE_REVOKE: "warning",
  ROLE_CHANGE_REQUESTED: "neutral",
  ROLE_CHANGE_REJECTED: "neutral",
  ADMIN_BOOTSTRAP: "info",
};

export const STATUS_TONES: Record<AccountStatus, Tone> = {
  PENDING_ACTIVATION: "neutral",
  ACTIVE: "success",
  SUSPENDED: "danger",
};

export const REQUEST_TONES: Record<RoleRequestStatus, Tone> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "neutral",
  EXPIRED: "neutral",
};

/** Names an account in a sentence; the console passes one that looks it up in its directory. */
export type Namer = (userId: unknown) => string;

const count = (value: unknown) => (typeof value === "number" ? value : "?");

/** One sentence for an alert, naming accounts through `name`. */
export function describeAlert(alert: Pick<AdminAlert, "kind" | "actorId" | "details">, name: Namer) {
  const d = alert.details;
  const actor = name(alert.actorId);
  switch (alert.kind) {
    case "ROLE_CHANGE": {
      const target = name(d.targetUserId);
      const change =
        d.role === "ADMIN" ? `made ${target} an administrator` : `removed ${target}'s administrator role`;
      return d.requestedBy === d.approvedBy
        ? `${actor} ${change} without a second administrator — none could approve.`
        : `${actor} ${change}, as ${name(d.requestedBy)} asked.`;
    }
    case "ADMIN_SUSPENDED":
      return `${actor} suspended the administrator ${name(d.targetUserId)}.`;
    case "BULK_SUSPENSIONS":
      return `${actor} suspended ${count(d.suspensionsInLastHour)} accounts within an hour (the alert is at ${count(d.threshold)}).`;
    case "SUSPENSION_LIMIT_REACHED":
      return `${actor} reached the limit of ${count(d.limit)} suspensions an hour; further suspensions were refused.`;
    case "BULK_READS":
      return `${actor} opened ${count(d.readsInLastHour)} accounts within an hour (the alert is at ${count(d.threshold)}).`;
  }
}

/**
 * A day range from two `<input type="date">` values, as the instants the API filters on: the start
 * of the first day and the end of the last, in the browser's time zone. Empty inputs are left out.
 */
export function dayRange(from: string, to: string): { from?: string; to?: string } {
  const day = (value: string, end: boolean) => {
    const [y, m, d] = value.split("-").map(Number);
    if (!y || !m || !d) return undefined;
    return (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
  };
  return { from: from ? day(from, false) : undefined, to: to ? day(to, true) : undefined };
}

const DATE_TIME: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
};

export const formatWhen = (iso: string) => new Date(iso).toLocaleString([], DATE_TIME);

/** "45 s", "12 min", "3 h 5 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

/** The first block of a UUID: enough to tell records apart on screen. */
export const shortId = (id: string) => id.slice(0, 8);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value.trim());
