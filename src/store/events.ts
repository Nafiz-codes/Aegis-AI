import type { Store } from "./db.js";
import type { NormalizedEvent, SeverityLevel } from "../types/events.js";

interface EventRow {
  id: string;
  source: string;
  external_id: string;
  source_name: string;
  source_url: string;
  type: string;
  severity_level: string;
  severity_score: number;
  confidence: number;
  title: string;
  description: string;
  location_name: string | null;
  lat: number;
  lon: number;
  affected_region: string | null;
  magnitude: number | null;
  occurred_at: string;
  expected_at: string | null;
  observed_at: string;
  raw: string | null;
}

function toEvent(row: EventRow): NormalizedEvent {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    type: row.type as NormalizedEvent["type"],
    severity: {
      level: row.severity_level as SeverityLevel,
      score: row.severity_score,
    },
    confidence: row.confidence,
    title: row.title,
    description: row.description,
    locationName: row.location_name ?? undefined,
    location: { lat: row.lat, lon: row.lon },
    affectedRegion: row.affected_region
      ? (JSON.parse(row.affected_region) as NormalizedEvent["affectedRegion"])
      : undefined,
    magnitude: row.magnitude ?? undefined,
    occurredAt: row.occurred_at,
    expectedAt: row.expected_at ?? undefined,
    observedAt: row.observed_at,
    raw: row.raw ? JSON.parse(row.raw) : undefined,
  };
}

export function recordEvent(store: Store, ev: NormalizedEvent): void {
  store.exec(
    `INSERT OR IGNORE INTO events
       (id, source, external_id, source_name, source_url, type,
        severity_level, severity_score, confidence,
        title, description, location_name, lat, lon, affected_region,
        magnitude, occurred_at, expected_at, observed_at, raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ev.id,
      ev.source,
      ev.externalId,
      ev.sourceName,
      ev.sourceUrl,
      ev.type,
      ev.severity.level,
      ev.severity.score,
      ev.confidence,
      ev.title,
      ev.description,
      ev.locationName ?? null,
      ev.location.lat,
      ev.location.lon,
      ev.affectedRegion ? JSON.stringify(ev.affectedRegion) : null,
      ev.magnitude ?? null,
      ev.occurredAt,
      ev.expectedAt ?? null,
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
