import { z } from "zod";
import { Channel } from "../types/user.js";
import { SEVERITY_TIERS } from "../types/events.js";

/**
 * The five priority tiers the emergency agent emits. We re-export `CRITICAL`,
 * `HIGH`, `MODERATE`, `LOW`, plus a synthetic `DIGEST` channel-level intent for
 * informational rollups that no single alert would warrant on its own.
 */
export const RoutingPriority = z.enum(SEVERITY_TIERS);
export type RoutingPriority = z.infer<typeof RoutingPriority>;

/**
 * The destination for one channel-pick. Independent of how the channel is
 * addressed — email inbox, Discord bot Dm, Telegram chat — the router only
 * needs to know WHO is on the other end.
 */
export const Recipient = z.object({
  channel: Channel,
  /** Display name (used in greeting lines; not used for addressing). */
  name: z.string().min(1),
  /** Address on that channel — email address / Discord user id / Telegram id. */
  address: z.string().min(1),
  /** Caspian connection id once the channel is connected. */
  connectionId: z.string().optional(),
});
export type Recipient = z.infer<typeof Recipient>;

/**
 * One alert's worth of content, stripped down to the channels-agnostic payload.
 * The router picks the formatter; the agent never builds a Discord- or
 * Telegram-specific string itself.
 */
export const AlertContent = z.object({
  /** One-line headline, ≤ 120 chars, already human-readable. */
  title: z.string().min(1).max(120),
  /** Body text, ≤ 1000 chars. Same factual content as the agent decided. */
  body: z.string().min(1).max(1000),
  /** Optional plain-text subject for email; ignored on chat channels. */
  subject: z.string().max(200).optional(),
  /** Canonical source URL — for the email footer / chat reference link. */
  sourceReference: z.string().url(),
  /** Source name (e.g. "USGS") — short attribution line. */
  sourceName: z.string().min(1),
});
export type AlertContent = z.infer<typeof AlertContent>;

/**
 * Routing intent — what the agent decided, plus the alert payload + audience.
 *
 * The router never invents values here; it only collapses the agent decision
 * into a set of channel-bound deliveries.
 */
export const RoutingIntent = z.object({
  /** Event id (used for logging + audit; not for addressing). */
  eventId: z.string().min(1),
  priority: RoutingPriority,
  /** The subset of channels the agent accepted — the router MUST NOT expand. */
  channels: z.array(Channel).min(1),
  content: AlertContent,
  recipients: z.array(Recipient).min(1),
  /** Number of retry attempts per channel on transient failure (default 2). */
  retries: z.number().int().min(0).max(5).default(2),
});
export type RoutingIntent = z.infer<typeof RoutingIntent>;

/**
 * Result of a single (recipient, channel) delivery attempt.
 *
 *   status === "delivered" — the channel returned a message id
 *                            (we treat Caspian's "accepted" response as
 *                             delivered for channels like email that don't
 *                             confirm receipt).
 *   status === "sending"   — call is still in flight (only meaningful for
 *                            streaming).
 *   status === "failed"    — call errored or status code indicated failure.
 *   status === "skipped"   — we never attempted (no contact, unverified
 *                            capability, audit rule, etc.).
 */
export type DeliveryStatus = "queued" | "sending" | "sent" | "delivered" | "failed" | "skipped";

export const DeliveryOutcome = z.object({
  recipient: z.string().min(1),
  channel: Channel,
  status: z.enum(["queued", "sending", "sent", "delivered", "failed", "skipped"]),
  attempts: z.number().int().min(0),
  /** Caspian-side message id once known. */
  messageId: z.string().optional(),
  /** Caspian-side conversation id once known. */
  conversationId: z.string().optional(),
  /** Last error string (only set when status === "failed" or "skipped"). */
  error: z.string().optional(),
});
export type DeliveryOutcome = z.infer<typeof DeliveryOutcome>;

/**
 * Whole-batch summary returned by {@link CommRouter.route}. Order matches the
 * input recipients.
 */
export interface RouteResult {
  outcomes: DeliveryOutcome[];
  /** Number of recipients still queued for retry. */
  pending: number;
  /** Per-priority counts, useful for batch dashboards. */
  summary: {
    delivered: number;
    failed: number;
    skipped: number;
  };
}
