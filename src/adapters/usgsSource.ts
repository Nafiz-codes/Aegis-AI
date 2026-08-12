import { createHash } from "node:crypto";
import type { DisasterSource } from "../services/disasterSource.js";
import type { DiscoveredEvent } from "../services/discoveredEvent.js";
import { DisasterType, Severity, type NormalizedEvent } from "../types/events.js";
import { childLogger } from "../logger.js";
import { loadConfig } from "../config.js";

const log = childLogger("usgs-source");

/** USGS GeoJSON feed shape — only the fields we touch. */
interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    title: string;
    place: string | null;
    time: number;
    url: string;
    detail?: string;
  };
  geometry: { coordinates: [number, number, number] } | null;
}

interface UsgsFeed {
  features: UsgsFeature[];
}

/**
 * USGS earthquake feed. Free, no key, GeoJSON. We use it for MVP because it is
 * the most reliable free source of real-time earthquake data.
 */
export class UsgsSource implements DisasterSource {
  readonly name = "usgs";

  constructor(private readonly feedUrl: string = loadConfig().USGS_FEED_URL) {}

  async fetch(sinceMs: number): Promise<DiscoveredEvent[]> {
    const res = await fetch(this.feedUrl, {
      headers: { "User-Agent": "aegis-ai/0.1 (hackathon)" },
    });
    if (!res.ok) {
      throw new Error(`USGS fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as UsgsFeed;
    const cutoff = sinceMs;
    const out: DiscoveredEvent[] = [];
    for (const f of data.features) {
      if (!f.geometry) continue;
      const [lon, lat, depthKm] = f.geometry.coordinates;
      if (f.properties.time < cutoff) continue;
      out.push({
        externalId: f.id,
        source: this.name,
        type: "earthquake",
        title: f.properties.title,
        description: `Depth ${depthKm.toFixed(1)} km — ${f.properties.url}`,
        locationName: f.properties.place ?? undefined,
        location: { lat, lon },
        magnitude: f.properties.mag ?? undefined,
        occurredAt: new Date(f.properties.time).toISOString(),
      });
    }
    log.debug({ count: out.length }, "usgs fetch done");
    return out;
  }

  normalize(d: DiscoveredEvent): NormalizedEvent {
    const mag = d.magnitude ?? 0;
    let severity: Severity;
    if (mag >= 7) severity = "sev1";
    else if (mag >= 6) severity = "sev2";
    else if (mag >= 5) severity = "sev3";
    else severity = "sev4";

    // Default affected radius scales with magnitude. Crude but demoable.
    const radiusKm = mag >= 7 ? 500 : mag >= 6 ? 300 : mag >= 5 ? 150 : 75;

    return {
      id: stableId(d.source, d.externalId),
      source: d.source,
      type: DisasterType.parse(d.type),
      severity,
      title: d.title,
      description: d.description ?? "",
      locationName: d.locationName,
      location: d.location,
      radiusKm,
      magnitude: d.magnitude,
      occurredAt: d.occurredAt,
      observedAt: new Date().toISOString(),
    };
  }
}

/** Stable id combining source + external id. */
export function stableId(source: string, externalId: string): string {
  return createHash("sha1")
    .update(`${source}:${externalId}`)
    .digest("hex")
    .slice(0, 16);
}
