import { createHash } from "node:crypto";
import type { DisasterSource, ValidationResult } from "../services/disasterSource.js";
import type { DiscoveredEvent } from "../services/discoveredEvent.js";
import {
  DisasterType,
  type NormalizedEvent,
  severityFromScore,
} from "../types/events.js";
import { childLogger } from "../logger.js";
import { loadConfig } from "../config.js";

const log = childLogger("usgs-source");

/** Lazily resolves to the configured USGS feed URL, never at import time. */
function defaultFeedUrl(): string {
  return loadConfig().USGS_FEED_URL;
}

/**
 * USGS GeoJSON feed shape — only the fields we touch. USGS exposes multiple
 * feeds at the same endpoint; `all_day.geojson` is the default for hackathon
 * demos because it is the most reliable free source of real-time earthquake
 * data worldwide.
 */
interface UsgsFeature {
  id: string;
  type?: string;
  properties: {
    mag: number | null;
    title: string;
    place: string | null;
    time: number;
    updated: number;
    url: string;
    detail?: string;
    felt?: number | null;
    tsunami?: number;
    sig?: number;
    type?: string;
    status?: string;
    /** USGS-reported minimum magnitude in the event cluster. */
    magMin?: number;
    types?: string;
    /** Depth in km (also present in geometry). */
    depth?: number;
  };
  geometry: { type: string; coordinates: [number, number, number] } | null;
}

interface UsgsFeed {
  type?: string;
  metadata?: { generated?: number; url?: string; title?: string; count?: number };
  features: UsgsFeature[];
}

/**
 * Default severity thresholds (configurable). Higher magnitude → higher
 * score. USGS `sig` (significance) is also factored in when present.
 *
 * These thresholds are intentionally generous — USGS publishes every
 * detectable quake and most are sub-perceptible. We want the agent to wake
 * up only for events that genuinely matter.
 */
const MAG_BANDS: Array<{ minMag: number; score: number }> = [
  { minMag: 7.0, score: 0.95 },
  { minMag: 6.0, score: 0.8 },
  { minMag: 5.5, score: 0.6 },
  { minMag: 5.0, score: 0.45 },
  { minMag: 4.0, score: 0.3 },
  { minMag: 3.0, score: 0.15 },
  { minMag: 0, score: 0.05 },
];

function magToScore(mag: number): number {
  for (const b of MAG_BANDS) if (mag >= b.minMag) return b.score;
  return 0;
}

const RADIUS_BANDS: Array<{ minMag: number; km: number }> = [
  { minMag: 7.0, km: 500 },
  { minMag: 6.0, km: 300 },
  { minMag: 5.0, km: 150 },
  { minMag: 4.0, km: 75 },
  { minMag: 0, km: 40 },
];

function magToRadius(mag: number): number {
  for (const b of RADIUS_BANDS) if (mag >= b.minMag) return b.km;
  return 40;
}

/**
 * USGS earthquake provider. Free, no API key, public, GeoJSON, machine-readable.
 * This is our first reliable provider for the disaster intelligence pipeline.
 *
 * Implements {@link DisasterSource} so additional providers (NWS, GDACS, etc.)
 * can be plugged in later without changing the agent.
 */
export class UsgsSource implements DisasterSource {
  readonly name = "usgs";
  readonly sourceName = "USGS Earthquake Hazards Program";

  constructor(private readonly feedUrl?: string) {}

  private get url(): string {
    return this.feedUrl ?? defaultFeedUrl();
  }

  /**
   * Fetch + parse + filter. Malformed provider rows are dropped here so the
   * rest of the pipeline only ever sees well-formed discoveries.
   */
  async fetch(sinceMs: number): Promise<DiscoveredEvent[]> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        headers: { "User-Agent": "aegis-ai/0.1 (hackathon)" },
      });
    } catch (err) {
      throw new Error(`USGS fetch network error: ${String(err)}`);
    }
    if (!res.ok) {
      throw new Error(`USGS fetch failed: ${res.status} ${res.statusText}`);
    }
    let data: UsgsFeed;
    try {
      data = (await res.json()) as UsgsFeed;
    } catch (err) {
      throw new Error(`USGS payload was not valid JSON: ${String(err)}`);
    }
    if (!Array.isArray(data.features)) {
      throw new Error("USGS payload missing 'features' array");
    }

    const out: DiscoveredEvent[] = [];
    let dropped = 0;
    for (const f of data.features) {
      const d = this.featureToDiscovered(f, sinceMs);
      if (d) {
        out.push(d);
      } else {
        dropped += 1;
      }
    }
    log.debug({ kept: out.length, dropped }, "usgs fetch done");
    return out;
  }

  normalize(d: DiscoveredEvent): NormalizedEvent {
    const mag = d.magnitude ?? 0;
    const score = magToScore(mag);
    const severity = severityFromScore(score);
    const radiusKm = magToRadius(mag);
    const sourceUrl = d.sourceUrl;
    const confidence =
      d.confidence ??
      // Heuristic: if USGS flagged tsunami=1 we treat as confirmed (1.0);
      // otherwise 0.7 for M≥5 and 0.5 below.
      (d.magnitude !== undefined && d.magnitude >= 5 ? 0.7 : 0.5);

    return {
      id: stableId(this.name, d.externalId),
      source: this.name,
      externalId: d.externalId,
      sourceName: this.sourceName,
      sourceUrl,
      type: DisasterType.parse(d.type),
      severity,
      confidence,
      title: d.title,
      description: d.description ?? "",
      locationName: d.locationName,
      location: d.location,
      affectedRegion: { kind: "radius", center: d.location, radiusKm },
      magnitude: d.magnitude,
      occurredAt: d.occurredAt,
      observedAt: new Date().toISOString(),
      raw: undefined,
    };
  }

  /**
   * USGS-specific validation on top of the agent's generic verifier. USGS
   * feeds every detectable quake, so we additionally require a real magnitude
   * (USGS sometimes reports null mag) before claiming the event is "real".
   */
  validate(ev: NormalizedEvent): ValidationResult {
    if (ev.source !== this.name) {
      return { ok: false, reason: "wrong-source", detail: `expected ${this.name}, got ${ev.source}` };
    }
    if (!isFinite(ev.magnitude as number) || ev.magnitude === undefined) {
      return { ok: false, reason: "missing-magnitude" };
    }
    return { ok: true };
  }

  /** Convert a single USGS feature into a discovered event, dropping bad rows. */
  private featureToDiscovered(f: UsgsFeature, sinceMs: number): DiscoveredEvent | null {
    if (!f || typeof f.id !== "string" || f.id.length === 0) return null;
    if (!f.geometry || f.geometry.type !== "Point") return null;
    const coords = f.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const [lon, lat, depthKm] = coords;
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    if (!isFinite(f.properties?.time)) return null;
    if (f.properties.time < sinceMs) return null;
    if (typeof f.properties.title !== "string" || f.properties.title.length === 0) return null;
    if (typeof f.properties.mag !== "number" || !isFinite(f.properties.mag)) return null;
    if (f.properties.status && f.properties.status !== "reviewed") {
      // Auto-generated/deleted rows are not authoritative.
      return null;
    }
    return {
      externalId: f.id,
      source: this.name,
      sourceName: this.sourceName,
      sourceUrl: f.properties.url ?? `https://earthquake.usgs.gov/earthquakes/eventpage/${f.id}`,
      type: "earthquake",
      severityScore: typeof f.properties.mag === "number" ? magToScore(f.properties.mag) : 0,
      confidence: typeof f.properties.mag === "number" && f.properties.mag >= 5 ? 0.7 : 0.5,
      title: f.properties.title,
      description: `Depth ${depthKm?.toFixed?.(1) ?? "?"} km — ${f.properties.url}`,
      locationName: f.properties.place ?? undefined,
      location: { lat, lon },
      radiusKm: typeof f.properties.mag === "number" ? magToRadius(f.properties.mag) : 40,
      magnitude: typeof f.properties.mag === "number" ? f.properties.mag : undefined,
      occurredAt: new Date(f.properties.time).toISOString(),
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
