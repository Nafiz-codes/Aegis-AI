import type { Block } from "caspian-sdk";
import type { Channel } from "../types/user.js";
import { childLogger } from "../logger.js";
import type { CommProvider } from "../services/commProvider.js";
import { UnverifiedCapabilityError } from "../adapters/caspianCommProvider.js";
import { formatForChannel } from "./formatter.js";
import {
  type AlertContent,
  type DeliveryOutcome,
  type Recipient,
  type RouteResult,
  type RoutingIntent,
  type RoutingPriority,
} from "./types.js";

const log = childLogger("comm-router");

/**
 * Channel preference per priority. The router never *expands* the set the
 * agent chose — it only orders / filters by urgency. The agent's job was to
 * decide which channels; the router's job is to put the right content on each.
 *
 *   CRITICAL — every channel at once (immediate push).
 *   HIGH     — push first (telegram + discord), then email as a backup record.
 *   MODERATE — single channel; email is the default digest, fallback to chat.
 *   LOW      — email-only digest/informational.
 */
const PUSH_CHANNELS: ReadonlyArray<Channel> = ["telegram", "discord", "email"];

export function orderChannelsByPriority(
  priority: RoutingPriority,
  channels: ReadonlyArray<Channel>,
): Channel[] {
  if (priority === "CRITICAL") {
    // All channels at once; don't reorder — let the agent decide order.
    return [...channels];
  }
  if (priority === "HIGH") {
    // Push first (telegram, discord, email), email last as a backup.
    return sortByPreference(channels, PUSH_CHANNELS);
  }
  if (priority === "MODERATE") {
    // Email-first for a normal notification; chat channels only if the
    // recipient opted in.
    return sortByPreference(channels, ["email", "discord", "telegram"]);
  }
  // LOW — email-only digest. Drop chat channels even if the agent allowed them.
  const only = channels.filter((c) => c === "email");
  return only.length > 0 ? only : [channels[0]!];
}

function sortByPreference(
  channels: ReadonlyArray<Channel>,
  pref: ReadonlyArray<Channel>,
): Channel[] {
  const rank = new Map(pref.map((c, i) => [c, i] as const));
  return [...channels].sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99));
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

export interface RouterOptions {
  /** Per-attempt timeout in ms before giving up on a single send. */
  perAttemptTimeoutMs?: number;
  /** Sleep between retries in ms (default 500). */
  retryBackoffMs?: number;
  /** Mockable sleep — used for tests to keep them instant. */
  sleep?: (ms: number) => Promise<void>;
  /** Hook called whenever an outcome transitions state. */
  onOutcome?: (o: DeliveryOutcome) => void;
}

/**
 * The {@link CommRouter} is the only channel-aware translation layer in the
 * system. The agent gives it a {@link RoutingIntent} and a {@link CommProvider};
 * the router:
 *
 *   1. Reorders channels by priority (push first for HIGH, email-first for MODERATE,
 *      chat-only for LOW).
 *   2. Picks the right formatter per channel so the SAME factual content
 *      looks native on Discord, Telegram, and email.
 *   3. Retries transient failures with exponential-ish backoff.
 *   4. Surfaces every state transition (queued → sending → retrying → sent/failed)
 *      through the {@link onOutcome} hook so the entrypoint can persist them.
 *
 * The router never reads Discord- or Telegram-specific fields. It only knows
 * about channels in the abstract.
 */
export class CommRouter {
  constructor(
    private readonly comm: CommProvider,
    private readonly opts: RouterOptions = {},
  ) {}

  /**
   * Route one {@link RoutingIntent} to all its recipients.
   *
   * Returns a {@link RouteResult} with one outcome per recipient. The router
   * NEVER throws — every failure is captured in the outcome.
   */
  async route(intent: RoutingIntent): Promise<RouteResult> {
    const orderedChannels = orderChannelsByPriority(intent.priority, intent.channels);
    const outcomes: DeliveryOutcome[] = [];

    let delivered = 0;
    let failed = 0;
    let skipped = 0;
    let pending = 0;

    for (const recipient of intent.recipients) {
      const isSubscribed = orderedChannels.includes(recipient.channel);
      if (!isSubscribed) {
        const o: DeliveryOutcome = {
          recipient: recipient.name,
          channel: recipient.channel,
          status: "skipped",
          attempts: 0,
          error: "channel not in agent-routed set",
        };
        this.emit(o);
        outcomes.push(o);
        skipped += 1;
        continue;
      }

      const o = await this.sendOne(recipient, intent.priority, intent.content, intent.retries);
      this.emit(o);
      outcomes.push(o);
      if (o.status === "delivered" || o.status === "sent") delivered += 1;
      else if (o.status === "failed") failed += 1;
      else if (o.status === "skipped") skipped += 1;
      else pending += 1;
    }

    return {
      outcomes,
      pending,
      summary: { delivered, failed, skipped },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async sendOne(
    recipient: Recipient,
    priority: RoutingPriority,
    content: AlertContent,
    retries: number,
  ): Promise<DeliveryOutcome> {
    const formatted = formatForChannel(
      recipient.channel,
      priority,
      content,
      recipient.name,
    );

    const maxAttempts = retries + 1;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const sending: DeliveryOutcome = {
        recipient: recipient.name,
        channel: recipient.channel,
        status: "sending",
        attempts: attempt,
      };
      this.emit(sending);

      try {
        const { conversationId, messageId } = await this.comm.sendAlert({
          contact: {
            channel: recipient.channel,
            address: recipient.address,
            connectionId: recipient.connectionId,
          },
          alert: {
            text: formatted.text,
            subject: formatted.subject,
            blocks: formatted.blocks as Block[] | undefined,
          },
        });

        const delivered: DeliveryOutcome = {
          recipient: recipient.name,
          channel: recipient.channel,
          status: "delivered",
          attempts: attempt,
          conversationId,
          messageId,
        };
        log.info(
          {
            channel: recipient.channel,
            recipient: recipient.name,
            attempt,
            messageId,
          },
          "delivered",
        );
        return delivered;
      } catch (err) {
        lastError = errToString(err);

        // Unverified capability is a permanent failure — no retry.
        if (err instanceof UnverifiedCapabilityError) {
          log.warn(
            {
              channel: recipient.channel,
              capability: err.capability,
              recipient: recipient.name,
            },
            "unverified capability — not retrying",
          );
          return {
            recipient: recipient.name,
            channel: recipient.channel,
            status: "skipped",
            attempts: attempt,
            error: `unverified capability: ${err.capability}`,
          };
        }

        if (attempt < maxAttempts) {
          const retrying: DeliveryOutcome = {
            recipient: recipient.name,
            channel: recipient.channel,
            status: "failed",
            attempts: attempt,
            error: lastError,
          };
          this.emit(retrying);
          await this.sleep(this.opts.retryBackoffMs ?? 500 * attempt);
          continue;
        }
      }
    }

    log.warn(
      {
        channel: recipient.channel,
        recipient: recipient.name,
        attempts: maxAttempts,
        err: lastError,
      },
      "all retries exhausted",
    );
    return {
      recipient: recipient.name,
      channel: recipient.channel,
      status: "failed",
      attempts: maxAttempts,
      error: lastError ?? "unknown failure",
    };
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    const s = this.opts.sleep ?? setTimeoutLikeSleep;
    await s(ms);
  }

  private emit(outcome: DeliveryOutcome): void {
    this.opts.onOutcome?.(outcome);
  }
}

function setTimeoutLikeSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
