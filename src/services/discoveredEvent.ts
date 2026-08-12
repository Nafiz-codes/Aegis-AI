import type { DisasterType, GeoPoint } from "../types/events.js";

/**
 * Raw shape a DisasterSource hands back from `fetch()` before normalization.
 * Providers fill what they know and leave the rest out — `normalize()` fills
 * the gaps with sensible defaults.
 */
export interface DiscoveredEvent {
  /** External id from the source. Combined with source name to dedup. */
  externalId: string;
  source: string;
  type: DisasterType;
  title: string;
  description?: string;
  locationName?: string;
  location: GeoPoint;
  radiusKm?: number;
  magnitude?: number;
  occurredAt: string;
}
