import { z } from "zod";
import { Channel } from "./user.js";
import { DisasterType, GeoPoint, SEVERITY_TIERS, type SeverityLevel } from "./events.js";

/**
 * Status of a dispatched alert.
 *
 * The lifecycle is:
 *   queued   — alert row created in the store, not yet handed to a channel.
 *   sending  — handed to the comm router and currently in flight.
 *   retrying — first send failed; the router is waiting before trying again.
 *   sent     — the channel accepted the message (Caspian returned an id).
 *   delivered — the channel confirmed delivery to the recipient (where the
 *                channel reports it; otherwise it stays at `sent`).
 *   failed   — all retries exhausted; the alert is permanently stuck.
 *   skipped  — never tried (e.g. no contact for the chosen channel, or the
 *                chosen capability isn't granted on this API key).
 */
export const AlertStatus = z.enum([
  "queued",
  "sending",
  "retrying",
  "sent",
  "delivered",
  "failed",
  "skipped",
]);
export type AlertStatus = z.infer<typeof AlertStatus>;

/** Final message to be sent to a single user on a single channel. */
export const ComposedAlert = z.object({
  subject: z.string().optional(),
  text: z.string().min(1),
  /** Channel-specific blocks when supported. */
  blocks: z.array(z.unknown()).optional(),
});
export type ComposedAlert = z.infer<typeof ComposedAlert>;

/** Per-recipient alert dispatch record. */
export const Alert = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  userId: z.string().min(1),
  channel: Channel,
  severity: z.enum(SEVERITY_TIERS),
  composed: ComposedAlert,
  status: AlertStatus,
  /** Caspian conversation id (once known) so we can send follow-ups. */
  conversationId: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Alert = z.infer<typeof Alert>;

/** Acknowledgement / response from a user. */
export const Ack = z.object({
  id: z.string().min(1),
  alertId: z.string().min(1),
  userId: z.string().min(1),
  channel: Channel,
  /** "safe" / "need_help" / "info" / "unknown". */
  response: z.enum(["safe", "need_help", "info", "unknown"]),
  rawText: z.string().optional(),
  receivedAt: z.string().datetime(),
});
export type Ack = z.infer<typeof Ack>;

/** Aggregated event info used by the decision pipeline. */
export const DecisionContext = z.object({
  event: z.object({
    id: z.string(),
    type: DisasterType,
    severity: z.enum(SEVERITY_TIERS),
    location: GeoPoint,
    locationName: z.string().optional(),
    radiusKm: z.number().optional(),
  }),
  user: z.object({
    id: z.string(),
    name: z.string(),
    subscribedChannels: z.array(Channel),
    distanceKm: z.number().optional(),
  }),
});
export type DecisionContext = z.infer<typeof DecisionContext>;
