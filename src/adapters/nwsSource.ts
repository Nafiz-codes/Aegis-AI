import type { DisasterSource, ValidationResult } from "../services/disasterSource.js";
import type { DiscoveredEvent } from "../services/discoveredEvent.js";
import {
  DisasterType,
  type NormalizedEvent,
  severityFromScore,
} from "../types/events.js";
import { childLogger } from "../logger.js";
import { loadConfig } from "../config.js";
import { stableId } from "./usgsSource.js";

const log = childLogger("nws-source");

interface NwsAlert {
  id: string;
  event: string;
  headline?: string;
  description?: string;
  areaDesc?: string;
  severity?: string;
  certainty?: string;
  effective?: string;
  expires?: string;
  sender?: string;
  /** NWS-reported severity. */
  severity_field?: string;
  geometry?: {
    type: string;
    coordinates: number[][][] | number[][][][];
  } | null;
}

/**
 * US National Weather Service active alerts feed. Requires a descriptive
 * User-Agent. Covers extreme weather, floods, wildfires (some).
 */
export class NwsSource implements DisasterSource {
  readonly name = "nws";
  readonly sourceName = "US National Weather Service";
  private readonly baseUrlOverride?: string;

  constructor(baseUrl?: string) {
    this.baseUrlOverride = baseUrl;
  }

  private get url(): string {
    const base = this.baseUrlOverride ?? loadConfig().NWS_API_BASE;
    return `${base.replace(/\/$/, "")}/alerts/active?status=actual&message_type=alert`;
  }

  async fetch(sinceMs: number): Promise<DiscoveredEvent[]> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        headers: { "User-Agent": "aegis-ai/0.1 (hackathon, contact: ops@aegis.ai)" },
      });
    } catch (err) {
      throw new Error(`NWS fetch network error: ${String(err)}`);
    }
    if (!res.ok) {
      throw new Error(`NWS fetch failed: ${res.status} ${res.statusText}`);
    }
    let data: { features?: Array<{ properties: NwsAlert }> };
    try {
      data = (await res.json()) as { features?: Array<{ properties: NwsAlert }> };
    } catch (err) {
      throw new Error(`NWS payload was not valid JSON: ${String(err)}`);
    }
    const features = data.features ?? [];
    const out: DiscoveredEvent[] = [];
    let dropped = 0;
    for (const f of features) {
      const d = this.featureToDiscovered(f, sinceMs);
      if (d) out.push(d);
      else dropped += 1;
    }
    log.debug({ kept: out.length, dropped }, "nws fetch done");
    return out;
  }

  normalize(d: DiscoveredEvent): NormalizedEvent {
    const score = d.severityScore ?? 0.4;
    const severity = severityFromScore(score);
    return {
      id: stableId(this.name, d.externalId),
      source: this.name,
      externalId: d.externalId,
      sourceName: this.sourceName,
      sourceUrl: d.sourceUrl,
      type: DisasterType.parse(d.type),
      severity,
      confidence: d.confidence ?? 0.7,
      title: d.title,
      description: d.description ?? "",
      locationName: d.locationName,
      location: d.location,
      affectedRegion: d.bbox ? { kind: "bbox", bbox: d.bbox } : undefined,
      magnitude: d.magnitude,
      occurredAt: d.occurredAt,
      expectedAt: d.expectedAt,
      observedAt: new Date().toISOString(),
      raw: undefined,
    };
  }

  validate(ev: NormalizedEvent): ValidationResult {
    if (ev.source !== this.name) {
      return { ok: false, reason: "wrong-source", detail: `expected ${this.name}, got ${ev.source}` };
    }
    return { ok: true };
  }

  private featureToDiscovered(
    f: { properties: NwsAlert },
    sinceMs: number,
  ): DiscoveredEvent | null {
    const p = f.properties;
    if (!p || typeof p.id !== "string") return null;
    const effective = p.effective ? Date.parse(p.effective) : 0;
    if (!isFinite(effective)) return null;
    if (effective < sinceMs) return null;
    const loc = firstPoint(p);
    if (!loc) return null;
    const sev = nwsSeverity(p);
    const score = sev === "CRITICAL" ? 0.9 : sev === "HIGH" ? 0.65 : sev === "MODERATE" ? 0.4 : 0.15;
    const bbox = firstBbox(p);
    return {
      externalId: p.id,
      source: this.name,
      sourceName: this.sourceName,
      sourceUrl: `https://api.weather.gov/alerts/${encodeURIComponent(p.id)}`,
      type: classifyNwsEvent(p.event),
      severity: sev,
      severityScore: score,
      confidence: 0.7,
      title: p.headline ?? p.event,
      description: p.description ?? "",
      locationName: p.areaDesc,
      location: loc,
      bbox: bbox ?? undefined,
      radiusKm: bbox ? undefined : 100,
      occurredAt: p.effective ?? new Date(effective).toISOString(),
      expectedAt: isFinite(Date.parse(p.expires ?? "")) ? p.expires : undefined,
    };
  }
}

function classifyNwsEvent(event: string): NormalizedEvent["type"] {
  const e = event.toLowerCase();
  if (e.includes("flood")) return "flood";
  if (e.includes("hurricane") || e.includes("tropical storm") || e.includes("cyclone"))
    return "cyclone";
  if (e.includes("fire") || e.includes("red flag")) return "wildfire";
  if (
    e.includes("tornado") ||
    e.includes("severe thunderstorm") ||
    e.includes("winter storm") ||
    e.includes("heat") ||
    e.includes("wind")
  )
    return "extreme_weather";
  return "other";
}

function nwsSeverity(p: NwsAlert): NormalizedEvent["severity"]["level"] {
  const s = (p.severity ?? "").toLowerCase();
  if (s.includes("extreme")) return "CRITICAL";
  if (s.includes("severe")) return "HIGH";
  if (s.includes("moderate")) return "MODERATE";
  return "LOW";
}

function firstPoint(alert: NwsAlert): NormalizedEvent["location"] | null {
  const g = alert.geometry;
  if (!g) return null;
  try {
    const coords = g.coordinates as unknown;
    let pt: number[] | undefined;
    if (g.type === "Point" && Array.isArray(coords)) {
      pt = coords as number[];
    } else if (g.type === "Polygon" && Array.isArray(coords)) {
      const ring = (coords as number[][][])[0];
      pt = ring?.[0];
    } else if (g.type === "MultiPolygon" && Array.isArray(coords)) {
      const ring = ((coords as number[][][][])[0] as number[][][])[0];
      pt = ring?.[0];
    }
    if (!pt || pt.length < 2) return null;
    const [lon, lat] = pt;
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

function firstBbox(
  alert: NwsAlert,
): { minLon: number; minLat: number; maxLon: number; maxLat: number } | null {
  const g = alert.geometry;
  if (!g) return null;
  try {
    let lons: number[] = [];
    let lats: number[] = [];
    if (g.type === "Polygon") {
      const ring = (g.coordinates as number[][][])[0];
      if (!Array.isArray(ring)) return null;
      for (const pt of ring) {
        if (typeof pt[0] !== "number" || typeof pt[1] !== "number") continue;
        lons.push(pt[0]);
        lats.push(pt[1]);
      }
    } else if (g.type === "MultiPolygon") {
      const ring = (g.coordinates as number[][][][])[0]?.[0];
      if (!Array.isArray(ring)) return null;
      for (const pt of ring) {
        if (typeof pt[0] !== "number" || typeof pt[1] !== "number") continue;
        lons.push(pt[0]);
        lats.push(pt[1]);
      }
    } else {
      return null;
    }
    if (lons.length === 0) return null;
    return {
      minLon: Math.min(...lons),
      minLat: Math.min(...lats),
      maxLon: Math.max(...lons),
      maxLat: Math.max(...lats),
    };
  } catch {
    return null;
  }
}
