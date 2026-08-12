import type { DisasterType, GeoPoint, SeverityLevel } from "../types/events.js";

/**
 * Raw shape a DisasterSource hands back from `fetch()` before normalization.
 * Providers fill what they know and leave the rest out — `normalize()` fills
 * the gaps with sensible defaults.
 */
export interface DiscoveredEvent {
  /** External id from the source. Combined with source name to dedup. */
  externalId: string;
  /** Stable source identifier (e.g. "usgs", "nws"). */
  source: string;
  /** Human-readable provider name. */
  sourceName: string;
  /** URL to the provider's event page. */
  sourceUrl: string;
  type: DisasterType;
  /** Provider-reported severity tier (optional — overridden by normalize). */
  severity?: SeverityLevel;
  /** Provider-reported numeric severity score in [0, 1]. */
  severityScore?: number;
  /** Provider-reported confidence in [0, 1]. */
  confidence?: number;
  title: string;
  description?: string;
  locationName?: string;
  location: GeoPoint;
  /** Affected-region radius (km), if known. */
  radiusKm?: number;
  /** Affected-region bbox, if known. */
  bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  magnitude?: number;
  /** Event time at source. */
  occurredAt: string;
  /** Expected/estimated timing for impact (e.g. cyclone landfall). */
  expectedAt?: string;
}
