import type { Store } from "./db.js";
import type { NormalizedEvent } from "../types/events.js";

interface EventRow {
  id: string;
  source: string;
  type: string;
  severity: string;
  title: string;
  description: string;
  location_name: string | null;
  lat: number;
  lon: number;
  radius_km: number | null;
  magnitude: number | null;
  occurred_at: string;
  observed_at: string;
  raw: string | null;
}

function toEvent(row: EventRow): NormalizedEvent {
  return {
    id: row.id,
    source: row.source,
    type: row.type as NormalizedEvent["type"],
    severity: row.severity as NormalizedEvent["severity"],
    title: row.title,
    description: row.description,
    locationName: row.location_name ?? undefined,
    location: { lat: row.lat, lon: row.lon },
    radiusKm: row.radius_km ?? undefined,
    magnitude: row.magnitude ?? undefined,
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    raw: row.raw ? JSON.parse(row.raw) : undefined,
  };
}

export function recordEvent(store: Store, ev: NormalizedEvent): void {
  store.exec(
    `INSERT OR IGNORE INTO events
       (id, source, type, severity, title, description, location_name, lat, lon, radius_km, magnitude, occurred_at, observed_at, raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ev.id,
      ev.source,
      ev.type,
      ev.severity,
      ev.title,
      ev.description,
      ev.locationName ?? null,
      ev.location.lat,
      ev.location.lon,
      ev.radiusKm ?? null,
      ev.magnitude ?? null,
      ev.occurredAt,
      ev.observedAt,
      ev.raw ? JSON.stringify(ev.raw) : null,
    ],
  );
}

export function hasEvent(store: Store, id: string): boolean {
  const row = store.first(
    `SELECT id FROM events WHERE id = ?`,
    [id],
    (r) => r["id"] as string,
  );
  return row !== null;
}

export function recentEvents(store: Store, limit = 20): NormalizedEvent[] {
  return store.all<NormalizedEvent>(
    `SELECT * FROM events ORDER BY observed_at DESC LIMIT ?`,
    [limit],
    (r) => toEvent(r as unknown as EventRow),
  );
}
