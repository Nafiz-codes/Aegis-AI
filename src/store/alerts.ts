import type { Store } from "./db.js";
import type { Alert, AlertStatus, ComposedAlert } from "../types/alerts.js";
import type { SeverityLevel } from "../types/events.js";
import type { Channel } from "../types/user.js";

interface AlertRow {
  id: string;
  event_id: string;
  user_id: string;
  channel: string;
  severity: string;
  composed: string;
  status: string;
  conversation_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    channel: row.channel as Channel,
    severity: row.severity as SeverityLevel,
    composed: JSON.parse(row.composed) as ComposedAlert,
    status: row.status as AlertStatus,
    conversationId: row.conversation_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertAlert(store: Store, alert: Alert): void {
  store.exec(
    `INSERT INTO alerts
       (id, event_id, user_id, channel, severity, composed, status, conversation_id, error, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      alert.id,
      alert.eventId,
      alert.userId,
      alert.channel,
      alert.severity,
      JSON.stringify(alert.composed),
      alert.status,
      alert.conversationId ?? null,
      alert.error ?? null,
      alert.createdAt,
      alert.updatedAt,
    ],
  );
}

export function updateAlertStatus(
  store: Store,
  id: string,
  status: AlertStatus,
  patch?: { conversationId?: string; error?: string },
): void {
  store.exec(
    `UPDATE alerts
     SET status = ?,
         conversation_id = COALESCE(?, conversation_id),
         error = COALESCE(?, error),
         updated_at = ?
     WHERE id = ?`,
    [
      status,
      patch?.conversationId ?? null,
      patch?.error ?? null,
      new Date().toISOString(),
      id,
    ],
  );
}

export function recordAck(
  store: Store,
  ack: {
    id: string;
    alertId: string;
    userId: string;
    channel: Channel;
    response: "safe" | "need_help" | "info" | "unknown";
    rawText?: string;
    receivedAt: string;
  },
): void {
  store.exec(
    `INSERT INTO acks (id, alert_id, user_id, channel, response, raw_text, received_at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      ack.id,
      ack.alertId,
      ack.userId,
      ack.channel,
      ack.response,
      ack.rawText ?? null,
      ack.receivedAt,
    ],
  );
}

export function recentAlerts(store: Store, limit = 20): Alert[] {
  return store.all<Alert>(
    `SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?`,
    [limit],
    (r) => toAlert(r as unknown as AlertRow),
  );
}
