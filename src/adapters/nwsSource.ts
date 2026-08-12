import type { DisasterSource } from "../services/disasterSource.js";
import type { DiscoveredEvent } from "../services/discoveredEvent.js";
import { DisasterType, Severity, type NormalizedEvent } from "../types/events.js";
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
  geometry?: {
    type: string;
    coordinates: number[][][] | number[][][][];
  } | null;
}

/**
 * US National Weather Service active alerts feed. Free, no key, requires a
 * descriptive User-Agent. Covers extreme weather, floods, wildfires (some).
 */
export class NwsSource implements DisasterSource {
  readonly name = "nws";
  private readonly url: string;

  constructor(baseUrl: string = loadConfig().NWS_API_BASE) {
    this.url = `${baseUrl.replace(/\/$/, "")}/alerts/active?status=actual&message_type=alert`;
  }

  async fetch(sinceMs: number): Promise<DiscoveredEvent[]> {
    const res = await fetch(this.url, {
      headers: { "User-Agent": "aegis-ai/0.1 (hackathon, contact: ops@aegis.ai)" },
    });
    if (!res.ok) {
      throw new Error(`NWS fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { features?: Array<{ properties: NwsAlert }> };
    const features = data.features ?? [];
    const out: DiscoveredEvent[] = [];
    for (const f of features) {
      const p = f.properties;
      const effective = p.effective ? Date.parse(p.effective) : 0;
      if (effective < sinceMs) continue;
      const loc = firstPoint(p);
      if (!loc) continue;
      out.push({
        externalId: p.id,
        source: this.name,
        type: classifyNwsEvent(p.event),
        title: p.headline ?? p.event,
        description: p.description ?? "",
        locationName: p.areaDesc,
        location: loc,
        occurredAt: p.effective ?? new Date(effective).toISOString(),
      });
    }
    log.debug({ count: out.length }, "nws fetch done");
    return out;
  }

  normalize(d: DiscoveredEvent): NormalizedEvent {
    const severity = nwsSeverity(d.title);
    return {
      id: stableId(d.source, d.externalId),
      source: d.source,
      type: DisasterType.parse(d.type),
      severity,
      title: d.title,
      description: d.description ?? "",
      locationName: d.locationName,
      location: d.location,
      radiusKm: 100,
      occurredAt: d.occurredAt,
      observedAt: new Date().toISOString(),
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

function nwsSeverity(title: string): Severity {
  const t = title.toLowerCase();
  if (t.includes("extreme")) return "sev1";
  if (t.includes("severe")) return "sev2";
  if (t.includes("moderate")) return "sev3";
  return "sev4";
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
