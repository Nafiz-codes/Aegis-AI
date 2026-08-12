import { createHash } from "node:crypto";
import type { NormalizedEvent } from "../types/events.js";
import type { User } from "../types/user.js";
import type { Alert, ComposedAlert } from "../types/alerts.js";
import type { LlmProvider } from "../services/llmProvider.js";
import { childLogger } from "../logger.js";

const log = childLogger("agent-decide");

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

/** Verify an event by cross-checking the source payload. MVP: trust source. */
export function verify(ev: NormalizedEvent): { ok: boolean; reason?: string } {
  if (!ev.location || !isFinite(ev.location.lat) || !isFinite(ev.location.lon)) {
    return { ok: false, reason: "missing-location" };
  }
  if (!ev.occurredAt) return { ok: false, reason: "missing-time" };
  return { ok: true };
}

/** Pick users in the affected region. MVP: radius match (if radius known). */
export function affectedUsers(event: NormalizedEvent, users: User[]): User[] {
  if (!event.radiusKm) return [];
  return users.filter((u) => {
    const d = distanceKm(event.location, u.location);
    return d <= event.radiusKm!;
  });
}

/** Choose channels + urgency based on severity. MVP rules. */
export function urgency(
  event: NormalizedEvent,
  user: User,
): { channels: User["subscribedChannels"]; tone: string } {
  const subs = user.subscribedChannels;
  switch (event.severity) {
    case "sev1":
      return { channels: subs, tone: "critical" };
    case "sev2":
      return { channels: subs, tone: "urgent" };
    case "sev3":
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

/** Compose a human-readable alert. Uses LLM if enabled, else template. */
export async function compose(
  event: NormalizedEvent,
  user: User,
  llm: LlmProvider,
): Promise<ComposedAlert> {
  const template = templateMessage(event, user);
  if (!llm.enabled) return template;

  const prompt = `Compose a short emergency alert for ${user.name}.
Event: ${event.title} (severity ${event.severity}, type ${event.type}).
Location: ${event.locationName ?? "unknown"} (lat=${event.location.lat}, lon=${event.location.lon}).
Magnitude: ${event.magnitude ?? "n/a"}.
Provide a one-sentence summary and one-sentence action.
Tone: ${template.text.startsWith("CRITICAL") ? "critical" : "calm"}.
Reply as plain text only.`;

  try {
    const llmText = await llm.complete({ system: "You write concise emergency alerts.", user: prompt, maxTokens: 200 });
    const text = llmText.trim() || template.text;
    return { subject: template.subject, text, blocks: template.blocks };
  } catch (err) {
    log.warn({ err: String(err) }, "llm failed, falling back to template");
    return template;
  }
}

function templateMessage(event: NormalizedEvent, user: User): ComposedAlert {
  const heading = `[${event.severity.toUpperCase()}] ${event.type.replace("_", " ")}`;
  const body = `${event.title}
Location: ${event.locationName ?? "near your area"}
Magnitude: ${event.magnitude ?? "n/a"}
Time: ${event.occurredAt}

Hi ${user.name}, this is an Aegis alert. Follow local guidance and check official sources for updates.`;
  return {
    subject: `${heading} — ${event.title}`,
    text: `${heading}\n\n${body}`,
    blocks: [
      { type: "heading", text: heading },
      { type: "text", text: body },
      { type: "buttons", buttons: [
        { label: "I am safe", value: "safe" },
        { label: "Need help", value: "need_help" },
      ]},
    ],
  };
}

/** Build an Alert record (queued) for a user+channel pair. */
export function buildAlert(input: {
  event: NormalizedEvent;
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
    severity: input.event.severity,
    composed: input.composed,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
}
