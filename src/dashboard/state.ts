import type { Store } from "../store/db.js";
import { recentAlerts } from "../store/alerts.js";
import { recentEvents } from "../store/events.js";
import { getActiveUsers } from "../store/users.js";
import { fmtClock } from "./bus.js";
import type { AlertStatus } from "../types/alerts.js";

/**
 * Snapshot of the dashboard's current view of the world. Returned by
 * `GET /api/state` and used by the static page renderer.
 */
export interface DashboardState {
  generatedAt: string;
  clock: string;
  counts: {
    activeEvents: number;
    verifiedToday: number;
    deliveredAlerts: number;
    failedAlerts: number;
    activeSubscribers: number;
  };
  globalThreat: "GREEN" | "AMBER" | "RED";
  events: DashboardEventRow[];
  recentAlerts: DashboardAlertRow[];
}

export interface DashboardEventRow {
  id: string;
  type: string;
  severity: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  title: string;
  source: string;
  sourceName: string;
  sourceUrl: string;
  locationName: string;
  lat: number;
  lon: number;
  occurredAt: string;
  observedAt: string;
  expectedAt: string | null;
  clock: string;
  affectedCount: number;
  channels: string[];
  deliveryCounts: { sent: number; failed: number; skipped: number; queued: number };
}

export interface DashboardAlertRow {
  id: string;
  eventId: string;
  channel: string;
  severity: string;
  status: AlertStatus;
  recipient: string;
  createdAt: string;
  clock: string;
}

/**
 * Build the dashboard state from the live store. This is the *only* place
 * the dashboard reads backend data; everything else (timeline) is streamed.
 */
export async function buildDashboardState(store: Store): Promise<DashboardState> {
  const events = recentEvents(store, 50);
  const alerts = recentAlerts(store, 200);
  const users = getActiveUsers(store);

  const byEvent = new Map<string, ReturnType<typeof aggregateAlertsByEvent>["get"] extends infer T ? T : never>();
  const agg = aggregateAlertsByEvent(alerts);

  const rows: DashboardEventRow[] = events.map((ev) => {
    const stat = agg.get(ev.id) ?? { sent: 0, failed: 0, skipped: 0, queued: 0, recipients: new Set<string>(), channels: new Set<string>() };
    return {
      id: ev.id,
      type: ev.type,
      severity: ev.severity.level,
      title: ev.title,
      source: ev.source,
      sourceName: ev.sourceName,
      sourceUrl: ev.sourceUrl,
      locationName: ev.locationName ?? "",
      lat: ev.location.lat,
      lon: ev.location.lon,
      occurredAt: ev.occurredAt,
      observedAt: ev.observedAt,
      expectedAt: ev.expectedAt ?? null,
      clock: fmtClock(ev.observedAt),
      affectedCount: stat.recipients.size,
      channels: Array.from(stat.channels),
      deliveryCounts: {
        sent: stat.sent,
        failed: stat.failed,
        skipped: stat.skipped,
        queued: stat.queued,
      },
    };
  });

  const delivered = alerts.filter((a) => a.status === "sent" || a.status === "delivered").length;
  const failed = alerts.filter((a) => a.status === "failed").length;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const verifiedToday = events.filter((e) => e.observedAt.startsWith(today)).length;

  const activeEvents = rows.filter((r) => {
    if (r.severity === "LOW") return false;
    return r.deliveryCounts.sent + r.deliveryCounts.queued > 0;
  }).length;

  const globalThreat = computeThreat(rows);

  return {
    generatedAt: now.toISOString(),
    clock: fmtClock(now.toISOString()),
    counts: {
      activeEvents,
      verifiedToday,
      deliveredAlerts: delivered,
      failedAlerts: failed,
      activeSubscribers: users.length,
    },
    globalThreat,
    events: rows,
    recentAlerts: alerts.slice(0, 25).map((a) => ({
      id: a.id,
      eventId: a.eventId,
      channel: a.channel,
      severity: a.severity,
      status: a.status,
      recipient: a.userId,
      createdAt: a.createdAt,
      clock: fmtClock(a.createdAt),
    })),
  };
}

function aggregateAlertsByEvent(alerts: ReadonlyArray<import("../types/alerts.js").Alert>): Map<
  string,
  { sent: number; failed: number; skipped: number; queued: number; recipients: Set<string>; channels: Set<string> }
> {
  const out = new Map<
    string,
    { sent: number; failed: number; skipped: number; queued: number; recipients: Set<string>; channels: Set<string> }
  >();
  for (const a of alerts) {
    const bucket =
      out.get(a.eventId) ??
      ({ sent: 0, failed: 0, skipped: 0, queued: 0, recipients: new Set<string>(), channels: new Set<string>() } as {
        sent: number;
        failed: number;
        skipped: number;
        queued: number;
        recipients: Set<string>;
        channels: Set<string>;
      });
    bucket.recipients.add(a.userId);
    bucket.channels.add(a.channel);
    if (a.status === "sent" || a.status === "delivered") bucket.sent += 1;
    else if (a.status === "failed") bucket.failed += 1;
    else if (a.status === "skipped") bucket.skipped += 1;
    else bucket.queued += 1;
    out.set(a.eventId, bucket);
  }
  return out;
}

function computeThreat(rows: DashboardEventRow[]): "GREEN" | "AMBER" | "RED" {
  const hasCritical = rows.some((r) => r.severity === "CRITICAL" && r.deliveryCounts.sent > 0);
  if (hasCritical) return "RED";
  const hasHigh = rows.some((r) => r.severity === "HIGH" && r.deliveryCounts.sent > 0);
  if (hasHigh) return "AMBER";
  return "GREEN";
}