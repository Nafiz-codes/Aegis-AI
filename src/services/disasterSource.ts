import type { NormalizedEvent } from "../types/events.js";
import type { DiscoveredEvent } from "./discoveredEvent.js";

/** Result of validating a normalized event. */
export interface ValidationResult {
  ok: boolean;
  /** Stable reason code (e.g. "missing-time", "out-of-range-lat"). */
  reason?: string;
  /** Human-readable details for logs. */
  detail?: string;
}

/**
 * A data source adapter that polls a trusted feed and emits normalized events.
 * The agent decides; the source only reports what it sees.
 *
 * Providers MUST validate their own payload (e.g. via `normalize()` returning
 * a zod-parseable object) and never return garbage. The pipeline still
 * re-validates as a defensive boundary.
 */
export interface DisasterSource {
  /** Stable name for logging/dedup (e.g. "usgs", "nws"). */
  readonly name: string;

  /**
   * Fetch the latest events since `sinceMs`. Implementations MUST translate
   * provider-specific payloads into `DiscoveredEvent` shape.
   *
   * Malformed provider rows are dropped here (with a log) so callers only
   * see well-formed discoveries.
   */
  fetch(sinceMs: number): Promise<DiscoveredEvent[]>;

  /**
   * Translate a discovered event into our normalized schema. Pure function —
   * no IO. Implementations may apply source-specific defaults (e.g. USGS
   * magnitude → severity score).
   */
  normalize(discovered: DiscoveredEvent): NormalizedEvent;

  /**
   * Validate a normalized event for structural integrity. Providers may
   * override to apply source-specific business rules (e.g. USGS confidence
   * must be ≥ 0.5 for sev1 events). Defaults to a schema-only check.
   */
  validate(event: NormalizedEvent): ValidationResult;
}
