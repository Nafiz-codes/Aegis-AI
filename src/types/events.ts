import { z } from "zod";

/** Disaster types we know how to classify. */
export const DisasterType = z.enum([
  "earthquake",
  "flood",
  "wildfire",
  "cyclone",
  "extreme_weather",
  "volcano",
  "other",
]);
export type DisasterType = z.infer<typeof DisasterType>;

/** Severity tiers. Lower number = higher urgency. */
export const Severity = z.enum(["sev1", "sev2", "sev3", "sev4"]);
export type Severity = z.infer<typeof Severity>;

/** A point-in-space with an uncertainty radius, used for geofencing. */
export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

/** Bounding box: [minLon, minLat, maxLon, maxLat]. */
export const BBox = z.object({
  minLon: z.number(),
  minLat: z.number(),
  maxLon: z.number(),
  maxLat: z.number(),
});
export type BBox = z.infer<typeof BBox>;

/**
 * Normalized disaster event produced by any DisasterSource adapter.
 * Downstream code (verify, severity, audience, urgency, compose) only ever
 * sees this shape.
 */
export const NormalizedEvent = z.object({
  /** Stable id = hash(source | type | location-time bucket). */
  id: z.string().min(1),
  source: z.string().min(1),
  type: DisasterType,
  severity: Severity,
  title: z.string().min(1),
  description: z.string().default(""),
  /** Optional human-readable place name (e.g. "Tokyo, JP"). */
  locationName: z.string().optional(),
  /** Best-known geographic anchor for the event. */
  location: GeoPoint,
  /** Optional radius (km) inside which subscribers may be affected. */
  radiusKm: z.number().positive().optional(),
  /** Optional bbox covering the affected region. */
  bbox: BBox.optional(),
  /** Magnitude (M for earthquakes, Saffir-Simpson for cyclones, etc.). */
  magnitude: z.number().optional(),
  /** Event time at source. */
  occurredAt: z.string().datetime(),
  /** When we first observed the event. */
  observedAt: z.string().datetime(),
  /** Raw payload for debugging/auditing. */
  raw: z.unknown().optional(),
});
export type NormalizedEvent = z.infer<typeof NormalizedEvent>;
