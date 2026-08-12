import type { NormalizedEvent } from "../types/events.js";
import type { DiscoveredEvent } from "./discoveredEvent.js";

/**
 * A data source adapter that polls a trusted feed and emits normalized events.
 * The agent decides; the source only reports what it sees.
 */
export interface DisasterSource {
  /** Stable name for logging/dedup (e.g. "usgs", "nws"). */
  readonly name: string;

  /**
   * Fetch the latest events since `sinceMs`. Implementations MUST translate
   * provider-specific payloads into `DiscoveredEvent` shape.
   */
  fetch(sinceMs: number): Promise<DiscoveredEvent[]>;

  /**
   * Translate a discovered event into our normalized schema. Pure function —
   * no IO. Implementations may apply source-specific defaults (e.g. USGS
   * magnitude → severity threshold).
   */
  normalize(discovered: DiscoveredEvent): NormalizedEvent;
}
