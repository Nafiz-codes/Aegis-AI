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

/**
 * Severity tiers. Lower number = higher urgency. The numeric `score` lets us
 * re-rank events from different providers on a shared scale; the `level`
 * label is the public tier that gets shown to users.
 *
 * Configurable at the source layer — each provider's `normalize()` maps its
 * raw scale to a Severity via {@link severityFromScore}.
 */
export const SEVERITY_TIERS = ["LOW", "MODERATE", "HIGH", "CRITICAL"] as const;
export type SeverityLevel = (typeof SEVERITY_TIERS)[number];

/** Numeric severity in [0, 1]. 0 = negligible, 1 = catastrophic. */
export const SeverityScore = z.number().min(0).max(1);

export const Severity = z.object({
  /** Public tier label (configurable). */
  level: z.enum(SEVERITY_TIERS),
  /** Normalised numeric score in [0, 1]. */
  score: SeverityScore,
});
export type Severity = z.infer<typeof Severity>;

/** Map a numeric score in [0, 1] to a tier. Thresholds are configurable below. */
export function severityFromScore(
  score: number,
  thresholds: { high: number; moderate: number; critical: number } = {
    /** Score at which we call something HIGH. */
    high: 0.3,
    /** Score at which we call something MODERATE. */
    moderate: 0.6,
    /** Score at which we call something CRITICAL. */
    critical: 0.85,
  },
): Severity {
  const s = Math.max(0, Math.min(1, score));
  let level: SeverityLevel;
  if (s >= thresholds.critical) level = "CRITICAL";
  else if (s >= thresholds.moderate) level = "HIGH";
  else if (s >= thresholds.high) level = "MODERATE";
  else level = "LOW";
  return { level, score: s };
}

/** Convenience: derive a tier from a legacy sev1..sev4 enum. */
export function legacySeverityToScore(legacy: "sev1" | "sev2" | "sev3" | "sev4"): Severity {
  switch (legacy) {
    case "sev1":
      return { level: "CRITICAL", score: 0.95 };
    case "sev2":
      return { level: "HIGH", score: 0.7 };
    case "sev3":
      return { level: "MODERATE", score: 0.45 };
    case "sev4":
      return { level: "LOW", score: 0.15 };
  }
}

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
 * Affected region. Either a radius around a point OR an explicit bbox.
 * Providers should fill whichever they have native data for; both are
 * preserved so the matcher can fall back.
 */
export const AffectedRegion = z.union([
  z.object({
    kind: z.literal("radius"),
    center: GeoPoint,
    radiusKm: z.number().positive(),
  }),
  z.object({
    kind: z.literal("bbox"),
    bbox: BBox,
  }),
]);
export type AffectedRegion = z.infer<typeof AffectedRegion>;

/**
 * Normalized disaster event produced by any DisasterSource adapter.
 * Downstream code (verify, severity, audience, urgency, compose) only ever
 * sees this shape.
 *
 * Deterministic/source fields are mandatory; the LLM is never allowed to
 * invent or modify them.
 */
export const NormalizedEvent = z.object({
  /** Stable id = hash(source | externalId). */
  id: z.string().min(1),
  source: z.string().min(1),
  /** Provider's external id (e.g. USGS event id, NWS alert id). */
  externalId: z.string().min(1),
  /** Human-readable provider name for logging. */
  sourceName: z.string().min(1),
  /** URL to the provider's event page — for the user's "more info" link. */
  sourceUrl: z.string().url(),
  type: DisasterType,
  severity: Severity,
  /**
   * Source-reported confidence in [0, 1]. 0 = rumor, 1 = confirmed by
   * provider. Low-confidence events should still reach the audience but the
   * AI must not escalate severity above what the provider claims.
   */
  confidence: z.number().min(0).max(1),
  title: z.string().min(1),
  description: z.string().default(""),
  /** Optional human-readable place name (e.g. "Tokyo, JP"). */
  locationName: z.string().optional(),
  /** Best-known geographic anchor for the event. */
  location: GeoPoint,
  /** Region affected by the event — drives user matching. */
  affectedRegion: AffectedRegion.optional(),
  /** Optional bbox covering the affected region (kept separately for legacy paths). */
  bbox: BBox.optional(),
  /** Magnitude (M for earthquakes, Saffir-Simpson for cyclones, etc.). */
  magnitude: z.number().optional(),
  /** Event time at source. */
  occurredAt: z.string().datetime(),
  /**
   * Expected/estimated timing for the event's impact window (ISO 8601).
   * For a cyclone this could be the projected landfall time, for a flash
   * flood the estimated crest time. Empty when the source doesn't supply one.
   */
  expectedAt: z.string().datetime().optional(),
  /** When we first observed the event in our pipeline. */
  observedAt: z.string().datetime(),
  /** Raw payload for debugging/auditing. */
  raw: z.unknown().optional(),
});
export type NormalizedEvent = z.infer<typeof NormalizedEvent>;

/**
 * A subset of normalized-event fields that the LLM is allowed to see and
 * paraphrase. Anything not in this shape is excluded from the prompt so the
 * model cannot fabricate factual disaster information.
 */
export const LLMSafeFactBundle = z.object({
  id: z.string(),
  source: z.string(),
  sourceName: z.string(),
  type: DisasterType,
  severityLevel: z.enum(SEVERITY_TIERS),
  title: z.string(),
  description: z.string(),
  locationName: z.string().optional(),
  magnitude: z.number().optional(),
  occurredAt: z.string(),
  expectedAt: z.string().optional(),
});
export type LLMSafeFactBundle = z.infer<typeof LLMSafeFactBundle>;
