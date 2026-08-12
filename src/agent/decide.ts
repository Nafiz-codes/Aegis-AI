import { createHash } from "node:crypto";
import {
  NormalizedEvent,
  type AffectedRegion,
  type LLMSafeFactBundle,
  type NormalizedEvent as NormalizedEventType,
  type Severity,
  type SeverityLevel,
  legacySeverityToScore,
  severityFromScore,
} from "../types/events.js";
import type { User } from "../types/user.js";
import { resolveSubscriptions } from "../types/user.js";
import type { Alert, ComposedAlert } from "../types/alerts.js";
import type { LlmProvider } from "../services/llmProvider.js";
import type { ValidationResult } from "../services/disasterSource.js";
import { childLogger } from "../logger.js";

const log = childLogger("agent-decide");

/* -------------------------------------------------------------------------- */
/* Geography                                                                  */
/* -------------------------------------------------------------------------- */

/** Haversine distance in km between two points. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function pointInBBox(
  p: { lat: number; lon: number },
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number },
): boolean {
  return (
    p.lon >= bbox.minLon &&
    p.lon <= bbox.maxLon &&
    p.lat >= bbox.minLat &&
    p.lat <= bbox.maxLat
  );
}

function pointInRegion(p: { lat: number; lon: number }, region: AffectedRegion): boolean {
  if (region.kind === "bbox") return pointInBBox(p, region.bbox);
  return distanceKm(p, region.center) <= region.radiusKm;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Schema-validating verifier with explicit reason codes. Returns the first
 * reason that fails so the caller can log it deterministically.
 */
export function verify(ev: NormalizedEventType): ValidationResult {
  // 1. Non-finite coords catch (matches explicit reason code, before schema).
  if (
    !isFinite(ev.location?.lat) ||
    !isFinite(ev.location?.lon)
  ) {
    return { ok: false, reason: "non-finite-coords" };
  }

  // 2. Schema-level parse (catches missing fields, wrong types, out-of-range).
  const parsed = NormalizedEvent.safeParse(ev);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join(".") || "(root)";
    return {
      ok: false,
      reason: "schema",
      detail: `${path}: ${issue?.message ?? "invalid"}`,
    };
  }
  const e = parsed.data;

  // 3. Coordinates must be finite (re-check after parse for safety).
  if (!isFinite(e.location.lat) || !isFinite(e.location.lon)) {
    return { ok: false, reason: "non-finite-coords" };
  }

  // 3. Time sanity — occurredAt not in the future, not before 1990.
  const occurredMs = Date.parse(e.occurredAt);
  if (!isFinite(occurredMs)) {
    return { ok: false, reason: "invalid-occurred-at" };
  }
  const nowMs = Date.now();
  if (occurredMs > nowMs + 5 * 60 * 1000) {
    return { ok: false, reason: "occurred-in-future" };
  }
  if (occurredMs < Date.UTC(1990, 0, 1)) {
    return { ok: false, reason: "occurred-too-old" };
  }

  // 4. observedAt must be ≥ occurredAt (observedAt is when we first saw it).
  const observedMs = Date.parse(e.observedAt);
  if (observedMs < occurredMs - 60 * 1000) {
    return { ok: false, reason: "observed-before-occurred" };
  }

  // 5. expectedAt (if present) must be ≥ occurredAt.
  if (e.expectedAt) {
    const expectedMs = Date.parse(e.expectedAt);
    if (!isFinite(expectedMs)) {
      return { ok: false, reason: "invalid-expected-at" };
    }
    if (expectedMs < occurredMs - 60 * 1000) {
      return { ok: false, reason: "expected-before-occurred" };
    }
  }

  // 6. Severity-confidence consistency. CRITICAL events with confidence < 0.4
  // are rejected — a CRITICAL classification requires provider confidence.
  if (e.severity.level === "CRITICAL" && e.confidence < 0.4) {
    return {
      ok: false,
      reason: "critical-low-confidence",
      detail: `severity=CRITICAL requires confidence ≥ 0.4, got ${e.confidence}`,
    };
  }

  // 7. Region sanity — radius must be ≤ Earth circumference / 2.
  if (e.affectedRegion?.kind === "radius" && e.affectedRegion.radiusKm > 20_000) {
    return { ok: false, reason: "implausible-radius" };
  }

  // 8. Source URL must resolve to something plausible (http/https).
  if (!/^https?:\/\//.test(e.sourceUrl)) {
    return { ok: false, reason: "invalid-source-url" };
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Severity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Configurable severity re-ranker. Takes a raw event with a provider-supplied
 * score and applies an optional policy adjustment (e.g. downgrade low
 * confidence, upgrade tsunami-adjacent quakes). Pure function.
 */
export interface SeverityPolicy {
  /** Confidence floor below which severity is clamped down by one tier. */
  lowConfidenceFloor?: number;
  /** Bump severity by one tier when event has these types. */
  upgradeTypes?: ReadonlyArray<string>;
  /** Minimum severity tier regardless of provider score. */
  floor?: SeverityLevel;
}

const LEVEL_RANK: Record<SeverityLevel, number> = {
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
  CRITICAL: 3,
};

const RANK_LEVEL: Record<number, SeverityLevel> = {
  0: "LOW",
  1: "MODERATE",
  2: "HIGH",
  3: "CRITICAL",
};

export function applySeverityPolicy(
  base: Severity,
  type: string,
  confidence: number,
  policy: SeverityPolicy = {},
): Severity {
  let rank = LEVEL_RANK[base.level];

  if (policy.floor) {
    rank = Math.max(rank, LEVEL_RANK[policy.floor]);
  }

  if (policy.upgradeTypes?.includes(type)) {
    rank = Math.min(3, rank + 1);
  }

  if (
    policy.lowConfidenceFloor !== undefined &&
    confidence < policy.lowConfidenceFloor &&
    rank > 0
  ) {
    rank -= 1;
  }

  const clampedRank = Math.max(0, Math.min(3, rank));
  const level = RANK_LEVEL[clampedRank] ?? base.level;
  // Re-derive the score so it's monotonic with the level.
  const score = 0.15 + 0.3 * clampedRank + base.score * 0.1;
  return { level, score: Math.min(1, score) };
}

export { severityFromScore, legacySeverityToScore };

/* -------------------------------------------------------------------------- */
/* User matching (geolocation + confidence)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pick users in the affected region. Returns users whose home location is
 * inside the event's affected region. If no region is supplied, returns
 * an empty list (callers can still send to high-priority channels if the
 * audience is empty).
 */
export function affectedUsers(
  event: NormalizedEventType,
  users: User[],
  opts: { confidenceFloor?: number } = {},
): User[] {
  if (event.confidence < (opts.confidenceFloor ?? 0)) return [];
  if (!event.affectedRegion) return [];

  // Legacy shim: resolveSubscriptions hoists `location` into a single-radius
  // subscription, so the region check below still works for users that haven't
  // migrated to subscribedLocations yet.
  return users.filter((u) => {
    const subs = resolveSubscriptions(u).locations;
    return subs.some((s) => pointInRegion(s.center, event.affectedRegion!));
  });
}

/* -------------------------------------------------------------------------- */
/* Alert decision (urgency + channels)                                         */
/* -------------------------------------------------------------------------- */

/** Choose channels + urgency based on severity. MVP rules. */
export function urgency(
  event: NormalizedEventType,
  user: User,
): { channels: User["subscribedChannels"]; tone: string } {
  const subs = user.subscribedChannels;
  switch (event.severity.level) {
    case "CRITICAL":
      return { channels: subs, tone: "critical" };
    case "HIGH":
      return { channels: subs, tone: "urgent" };
    case "MODERATE":
      return { channels: filterPreferred(subs, ["email"]), tone: "advisory" };
    default:
      return { channels: ["email"], tone: "info" };
  }
}

function filterPreferred(channels: User["subscribedChannels"], preferred: User["subscribedChannels"]) {
  const preferredSet = new Set(preferred);
  const filtered = channels.filter((c) => preferredSet.has(c));
  return filtered.length > 0 ? filtered : channels;
}

/* -------------------------------------------------------------------------- */
/* Composition (LLM guardrails — no fabrication)                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the structured fact bundle handed to the LLM. Crucially this excludes
 * location coordinates, IDs, and other fields the model has no business
 * inventing. The model can only rephrase these fields.
 */
export function factBundle(event: NormalizedEventType): LLMSafeFactBundle {
  return {
    id: event.id,
    source: event.source,
    sourceName: event.sourceName,
    type: event.type,
    severityLevel: event.severity.level,
    title: event.title,
    description: event.description,
    locationName: event.locationName,
    magnitude: event.magnitude,
    occurredAt: event.occurredAt,
    expectedAt: event.expectedAt,
  };
}

/**
 * The required fact tokens that MUST appear in any composed message. If
 * the LLM output drops any of them, we fall back to the template. This is
 * the hard guarantee that no factual disaster information is fabricated
 * or omitted.
 */
function requiredFactTokens(b: LLMSafeFactBundle): string[] {
  return [
    b.sourceName,
    b.type.replace("_", " "),
    b.severityLevel,
    b.locationName ?? "your area",
  ];
}

function containsAllTokens(text: string, tokens: string[]): boolean {
  const lower = text.toLowerCase();
  return tokens.every((t) => lower.includes(t.toLowerCase()));
}

/**
 * Compose a human-readable alert. The LLM is constrained to a structured
 * fact bundle and any response that drops required fact tokens is rejected
 * in favour of the deterministic template.
 */
export async function compose(
  event: NormalizedEventType,
  user: User,
  llm: LlmProvider,
): Promise<ComposedAlert> {
  const template = templateMessage(event, user);
  if (!llm.enabled) return template;

  const bundle = factBundle(event);
  const prompt = `You are composing an emergency alert for ${user.name}.
Use ONLY the facts below. Do NOT invent locations, magnitudes, times, or
severities that are not in the bundle. Keep the message under 80 words.

FACT BUNDLE (JSON):
${JSON.stringify(bundle, null, 2)}

Reply as plain text only. The message MUST mention: ${requiredFactTokens(bundle).join(", ")}.`;

  try {
    const llmText = (await llm.complete({
      system: "You write concise emergency alerts using only the facts you are given.",
      user: prompt,
      maxTokens: 200,
    })).trim();

    if (!llmText) return template;
    if (!containsAllTokens(llmText, requiredFactTokens(bundle))) {
      log.warn({ eventId: event.id }, "llm output dropped required fact tokens — using template");
      return template;
    }
    return {
      subject: template.subject,
      text: llmText,
      blocks: template.blocks,
    };
  } catch (err) {
    log.warn({ err: String(err) }, "llm failed, falling back to template");
    return template;
  }
}

function templateMessage(event: NormalizedEventType, user: User): ComposedAlert {
  const heading = `[${event.severity.level}] ${event.type.replace("_", " ")}`;
  const body = `${event.title}
Source: ${event.sourceName}
Location: ${event.locationName ?? "near your area"}
Magnitude: ${event.magnitude ?? "n/a"}
Time: ${event.occurredAt}${event.expectedAt ? `\nExpected: ${event.expectedAt}` : ""}

Hi ${user.name}, this is an Aegis alert. Follow local guidance and check official sources for updates.`;
  return {
    subject: `${heading} — ${event.title}`,
    text: `${heading}\n\n${body}`,
    blocks: [
      { type: "heading", text: heading },
      { type: "text", text: body },
      {
        type: "buttons",
        buttons: [
          { label: "I am safe", value: "safe" },
          { label: "Need help", value: "need_help" },
        ],
      },
    ],
  };
}

/** Build an Alert record (queued) for a user+channel pair. */
export function buildAlert(input: {
  event: NormalizedEventType;
  user: User;
  channel: User["subscribedChannels"][number];
  composed: ComposedAlert;
}): Alert {
  const now = new Date().toISOString();
  const id = createHash("sha1")
    .update(`${input.event.id}:${input.user.id}:${input.channel}:${now}`)
    .digest("hex")
    .slice(0, 16);
  return {
    id,
    eventId: input.event.id,
    userId: input.user.id,
    channel: input.channel,
    severity: input.event.severity.level,
    composed: input.composed,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
}
