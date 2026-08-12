import { z } from "zod";
import { Channel } from "./user.js";
import { DisasterType, GeoPoint, Severity } from "./events.js";

/** Status of a dispatched alert. */
export const AlertStatus = z.enum([
  "queued",
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
  severity: Severity,
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
    severity: Severity,
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
