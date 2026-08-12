import type { Block } from "caspian-sdk";
import type { Channel } from "../types/user.js";
import { childLogger } from "../logger.js";
import type { AlertContent, RoutingPriority } from "./types.js";

const log = childLogger("comm-formatter");

/**
 * The router ships a single {@link AlertContent} per (event, recipient) pair.
 * Each channel wants a different shape:
 *
 *   Discord  — rich blocks (heading, body, action buttons, source link).
 *              Short, declarative, with an emoji prefix for at-a-glance severity.
 *   Telegram — text + optional inline keyboard. Telegram degrades Blocks to
 *              text automatically, but we craft a tighter plaintext version
 *              that respects the platform's length expectations.
 *   Email    — plain-text subject + body, with a source link in the footer.
 *
 * The factual content (`title`, `body`, `sourceReference`) is identical across
 * channels — we only rewrap, prefix, and decorate.
 */

export interface FormattedMessage {
  /** Plain-text body sent to every channel. */
  text: string;
  /** Optional subject — only used on email. */
  subject?: string;
  /** Optional HTML body — only used on email when the channel supports it. */
  html?: string;
  /** Optional native blocks — Discord/Telegram render these, email degrades. */
  blocks?: Block[];
}

/* -------------------------------------------------------------------------- */
/* Per-channel builders                                                        */
/* -------------------------------------------------------------------------- */

const PRIORITY_PREFIX: Record<RoutingPriority, string> = {
  CRITICAL: "🚨 CRITICAL",
  HIGH: "⚠️ HIGH PRIORITY",
  MODERATE: "ℹ️ ADVISORY",
  LOW: "📰 DIGEST",
};

const PRIORITY_SUBJECT_PREFIX: Record<RoutingPriority, string> = {
  CRITICAL: "[URGENT] Severe Weather Alert",
  HIGH: "[ACTION REQUIRED] Severe Weather Alert",
  MODERATE: "Weather Advisory",
  LOW: "Weather Digest",
};

export function formatForChannel(
  channel: Channel,
  priority: RoutingPriority,
  content: AlertContent,
  recipientName: string,
): FormattedMessage {
  switch (channel) {
    case "discord":
      return formatDiscord(priority, content, recipientName);
    case "telegram":
      return formatTelegram(priority, content, recipientName);
    case "email":
      return formatEmail(priority, content, recipientName);
    default: {
      // Exhaustiveness check — Channel is a closed enum.
      const exhaustive: never = channel;
      log.warn({ channel: exhaustive }, "unknown channel — falling back to email");
      return formatEmail(priority, content, recipientName);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Discord                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Discord gets the full rich-block treatment:
 *   Heading: 🚨 HIGH PRIORITY — earthquake
 *   Body:    facts + a one-line attribution
 *   Buttons: "I am safe" / "Need help" (callbacks for the router to handle)
 *   Link:    source reference as a URL button
 */
function formatDiscord(
  priority: RoutingPriority,
  content: AlertContent,
  recipientName: string,
): FormattedMessage {
  const prefix = PRIORITY_PREFIX[priority];
  const heading = `${prefix} — ${content.title}`;
  const body = [
    `Hi ${recipientName}, here is the latest from ${content.sourceName}:`,
    "",
    content.body,
    "",
    `Stay safe and follow local guidance.`,
    `Source: ${content.sourceReference}`,
  ].join("\n");

  const blocks: Block[] = [
    { type: "heading", text: heading },
    { type: "text", text: body },
    {
      type: "buttons",
      buttons: [
        { label: "I am safe", value: "safe" },
        { label: "Need help", value: "need_help" },
        { label: "More info", url: content.sourceReference },
      ],
    },
  ];

  return {
    text: `${heading}\n\n${body}`,
    subject: undefined,
    blocks,
  };
}

/* -------------------------------------------------------------------------- */
/* Telegram                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Telegram gets a tight, human-readable message. Inline keyboards replaced
 * with a single "More info" URL button block.
 */
function formatTelegram(
  priority: RoutingPriority,
  content: AlertContent,
  recipientName: string,
): FormattedMessage {
  const prefix = PRIORITY_PREFIX[priority];
  const heading = `${prefix} — ${content.title}`;
  const body = [
    `Hi ${recipientName}, your subscribed region may be affected.`,
    "",
    content.body,
    "",
    `Source: ${content.sourceReference}`,
  ].join("\n");

  const blocks: Block[] = [
    { type: "heading", text: heading },
    { type: "text", text: body },
    {
      type: "buttons",
      buttons: [{ label: "More info", url: content.sourceReference }],
    },
  ];

  return {
    text: `${heading}\n\n${body}`,
    subject: undefined,
    blocks,
  };
}

/* -------------------------------------------------------------------------- */
/* Email                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Email gets a real subject line and a newline-delimited body. We render a
 * minimal HTML variant for clients that prefer it; html is null otherwise.
 */
function formatEmail(
  priority: RoutingPriority,
  content: AlertContent,
  recipientName: string,
): FormattedMessage {
  const subjectPrefix = PRIORITY_SUBJECT_PREFIX[priority];
  const subject = `${subjectPrefix} — ${content.title}`;
  const body = [
    `Hi ${recipientName},`,
    "",
    content.body,
    "",
    `---`,
    `Source: ${content.sourceName}`,
    `More info: ${content.sourceReference}`,
    "Follow local guidance and check official sources for updates.",
    "",
    "— Aegis AI",
  ].join("\n");

  const html = [
    `<p>Hi ${escapeHtml(recipientName)},</p>`,
    `<p>${escapeHtml(content.body).replace(/\n/g, "<br>")}</p>`,
    `<hr>`,
    `<p><strong>Source:</strong> ${escapeHtml(content.sourceName)}<br>`,
    `<a href="${escapeHtml(content.sourceReference)}">More info</a></p>`,
    `<p><small>Follow local guidance and check official sources for updates.<br>`,
    `— Aegis AI</small></p>`,
  ].join("");

  return {
    text: body,
    subject,
    html,
    blocks: undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
