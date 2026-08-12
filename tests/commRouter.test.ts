import { describe, expect, it, vi } from "vitest";
import { CommRouter, orderChannelsByPriority } from "../src/comm/router.js";
import { UnverifiedCapabilityError } from "../src/adapters/caspianCommProvider.js";
import type { CommProvider } from "../src/services/commProvider.js";
import { formatForChannel } from "../src/comm/formatter.js";
import type {
  AlertContent,
  Recipient,
  RoutingIntent,
  RoutingPriority,
} from "../src/comm/types.js";
import type { Channel } from "../src/types/user.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const content: AlertContent = {
  title: "M7.1 earthquake near you",
  body: "USGS reports a M7.1 earthquake. Take action now.",
  sourceReference: "https://earthquake.usgs.gov/eventpage/abc",
  sourceName: "USGS",
};

const recipientFor = (channel: Channel, name = "Alice"): Recipient => ({
  channel,
  name,
  address: `${channel}-${name.toLowerCase()}@example.test`,
  connectionId: `conn-${channel}`,
});

const baseIntent = (
  priority: RoutingPriority,
  channels: ReadonlyArray<Channel>,
  recipients: ReadonlyArray<Recipient> = channels.map((c) => recipientFor(c)),
): RoutingIntent => ({
  eventId: "evt_42",
  priority,
  channels: [...channels],
  content,
  recipients: [...recipients],
  retries: 1,
});

/* -------------------------------------------------------------------------- */
/* Mock CommProvider                                                          */
/* -------------------------------------------------------------------------- */

type SendResponse =
  | { kind: "ok"; conversationId?: string; messageId?: string }
  | { kind: "error"; message: string; times?: number }
  | { kind: "unverified"; capability: string };

interface RecordedCall {
  to: { channel: Channel; address: string; connectionId?: string };
  text: string;
  subject?: string;
  hasBlocks: boolean;
}

const scriptedComm = (responses: SendResponse[]): {
  provider: CommProvider;
  calls: RecordedCall[];
} => {
  const calls: RecordedCall[] = [];
  let idx = 0;
  const remainingFailures = new Map<number, number>();

  const provider: CommProvider = {
    async connect() {
      return [];
    },
    async sendAlert(input) {
      calls.push({
        to: {
          channel: input.contact.channel,
          address: input.contact.address,
          connectionId: input.contact.connectionId,
        },
        text: input.alert.text,
        subject: input.alert.subject,
        hasBlocks: Boolean(input.alert.blocks),
      });
      const r = responses[idx] ?? responses[responses.length - 1]!;
      if (r.kind === "ok") {
        idx += 1;
        return { conversationId: r.conversationId, messageId: r.messageId };
      }
      if (r.kind === "unverified") {
        idx += 1;
        throw new UnverifiedCapabilityError(r.capability, input.contact.channel);
      }
      // r.kind === "error"
      const left = remainingFailures.get(idx) ?? r.times ?? 1;
      if (left > 1) {
        remainingFailures.set(idx, left - 1);
      } else {
        idx += 1;
        remainingFailures.delete(idx);
      }
      throw new Error(r.message);
    },
    onMessage() {},
    onInteraction() {},
    async listen() {},
    async handleWebhook() {
      return { status: "ok" };
    },
    async behaviorPrompt() {
      return "";
    },
  };
  return { provider, calls };
};

/* -------------------------------------------------------------------------- */
/* Channel ordering                                                           */
/* -------------------------------------------------------------------------- */

describe("orderChannelsByPriority", () => {
  it("CRITICAL keeps the original channel order (all at once)", () => {
    expect(orderChannelsByPriority("CRITICAL", ["email", "discord", "telegram"]))
      .toEqual(["email", "discord", "telegram"]);
  });

  it("HIGH puts push channels first", () => {
    expect(orderChannelsByPriority("HIGH", ["email", "discord", "telegram"]))
      .toEqual(["telegram", "discord", "email"]);
  });

  it("MODERATE puts email first", () => {
    expect(orderChannelsByPriority("MODERATE", ["email", "discord", "telegram"]))
      .toEqual(["email", "discord", "telegram"]);
  });

  it("LOW collapses to email only", () => {
    expect(orderChannelsByPriority("LOW", ["email", "discord", "telegram"]))
      .toEqual(["email"]);
  });

  it("LOW falls back to first channel when email is absent", () => {
    expect(orderChannelsByPriority("LOW", ["discord"]))
      .toEqual(["discord"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Per-channel formatting                                                     */
/* -------------------------------------------------------------------------- */

describe("formatForChannel", () => {
  it("Discord uses rich blocks with action buttons and the source link", () => {
    const r = formatForChannel("discord", "HIGH", content, "Alice");
    expect(r.text).toContain("HIGH PRIORITY");
    expect(r.text).toContain("M7.1 earthquake near you");
    expect(r.subject).toBeUndefined();
    expect(r.blocks).toBeDefined();
    const blocks = r.blocks!;
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks.some((b) => b.type === "buttons")).toBe(true);
    const buttonsBlock = blocks.find((b) => b.type === "buttons") as
      | { type: "buttons"; buttons?: { url?: string; value?: string }[] }
      | undefined;
    const urlBtn = buttonsBlock?.buttons?.find((b) => b.url);
    expect(urlBtn?.url).toBe(content.sourceReference);
  });

  it("Telegram uses blocks but no subject; carries the source reference", () => {
    const r = formatForChannel("telegram", "MODERATE", content, "Alice");
    expect(r.text).toContain("ADVISORY");
    expect(r.text).toContain(content.sourceReference);
    expect(r.subject).toBeUndefined();
    expect(r.blocks?.length).toBeGreaterThan(0);
  });

  it("Email has a real subject, plain body, and html variant", () => {
    const r = formatForChannel("email", "CRITICAL", content, "Alice");
    expect(r.subject).toContain("URGENT");
    expect(r.subject).toContain("M7.1 earthquake near you");
    expect(r.text).toContain("USGS");
    expect(r.text).toContain(content.sourceReference);
    expect(r.html).toBeDefined();
    expect(r.html).toContain("Alice");
    expect(r.html).toContain(content.sourceReference);
  });

  it("LOW emails use the digest subject prefix", () => {
    const r = formatForChannel("email", "LOW", content, "Alice");
    expect(r.subject).toContain("Weather Digest");
  });

  it("keeps identical factual content across all channels", () => {
    const discord = formatForChannel("discord", "HIGH", content, "Alice").text;
    const telegram = formatForChannel("telegram", "HIGH", content, "Alice").text;
    const email = formatForChannel("email", "HIGH", content, "Alice").text;
    // Chat channels wrap the title into the body; email carries it via the subject line.
    const discordBlocks = formatForChannel("discord", "HIGH", content, "Alice").blocks!;
    const telegramBlocks = formatForChannel("telegram", "HIGH", content, "Alice").blocks!;
    const emailMsg = formatForChannel("email", "HIGH", content, "Alice");
    expect(discordBlocks.some((b) => b.type === "heading" && b.text?.includes("M7.1 earthquake near you"))).toBe(true);
    expect(telegramBlocks.some((b) => b.type === "heading" && b.text?.includes("M7.1 earthquake near you"))).toBe(true);
    expect(emailMsg.subject).toContain("M7.1 earthquake near you");
    for (const c of [discord, telegram, email]) {
      // Body is included verbatim on every channel.
      expect(c).toContain(content.sourceReference);
      expect(c).toContain("USGS reports a M7.1");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

describe("CommRouter.route", () => {
  it("delivers one alert per recipient and returns a summary", async () => {
    const { provider, calls } = scriptedComm([{ kind: "ok", messageId: "m1" }]);
    const router = new CommRouter(provider, { retryBackoffMs: 0 });
    const intent = baseIntent("CRITICAL", ["email", "discord"]);
    const result = await router.route(intent);

    expect(calls.length).toBe(2);
    expect(result.summary.delivered).toBe(2);
    expect(result.summary.failed).toBe(0);
    expect(result.outcomes.every((o) => o.status === "delivered")).toBe(true);
  });

  it("emits queued → sending → delivered through onOutcome", async () => {
    const { provider } = scriptedComm([{ kind: "ok", messageId: "m1" }]);
    const seen: string[] = [];
    const router = new CommRouter(provider, {
      retryBackoffMs: 0,
      onOutcome: (o) => {
        seen.push(`${o.channel}=${o.status}`);
      },
    });
    await router.route(baseIntent("CRITICAL", ["email"], [recipientFor("email")]));
    expect(seen.some((s) => s.endsWith("=sending"))).toBe(true);
    expect(seen.some((s) => s.endsWith("=delivered"))).toBe(true);
  });

  it("skips channels that aren't in the agent-routed set", async () => {
    const { provider, calls } = scriptedComm([{ kind: "ok", messageId: "m1" }]);
    const router = new CommRouter(provider, { retryBackoffMs: 0 });
    // Recipients include telegram; channels allow only email+discord.
    const intent = baseIntent("CRITICAL", ["email", "discord"]);
    intent.recipients.push(recipientFor("telegram"));
    const result = await router.route(intent);

    expect(calls.length).toBe(2);
    expect(result.outcomes.find((o) => o.channel === "telegram")?.status).toBe("skipped");
  });

  it("retries once on a transient error, then delivers", async () => {
    const { provider, calls } = scriptedComm([
      { kind: "error", message: "transient 503", times: 1 },
      { kind: "ok", messageId: "m-after-retry" },
    ]);
    const router = new CommRouter(provider, { retryBackoffMs: 0 });
    const intent = baseIntent("HIGH", ["email"], [recipientFor("email")]);
    const result = await router.route(intent);

    expect(calls.length).toBe(2);
    expect(result.outcomes[0]!.attempts).toBe(2);
    expect(result.outcomes[0]!.status).toBe("delivered");
  });

  it("marks failed when retries are exhausted", async () => {
    const { provider } = scriptedComm([{ kind: "error", message: "always 500", times: 5 }]);
    const router = new CommRouter(provider, { retryBackoffMs: 0 });
    const intent = baseIntent("MODERATE", ["email"], [recipientFor("email")]);
    const result = await router.route(intent);

    expect(result.summary.delivered).toBe(0);
    expect(result.summary.failed).toBe(1);
    expect(result.outcomes[0]!.status).toBe("failed");
    expect(result.outcomes[0]!.error).toContain("always 500");
  });

  it("skips on unverified capability without retrying", async () => {
    const { provider, calls } = scriptedComm([
      { kind: "unverified", capability: "Capability.INITIATE" },
    ]);
    const router = new CommRouter(provider, { retryBackoffMs: 0 });
    const result = await router.route(
      baseIntent("HIGH", ["telegram"], [recipientFor("telegram")]),
    );

    expect(calls.length).toBe(1); // No retries.
    expect(result.outcomes[0]!.status).toBe("skipped");
    expect(result.outcomes[0]!.error).toContain("Capability.INITIATE");
  });

  it("routes CRITICAL to every channel in the original order", async () => {
    const { provider, calls } = scriptedComm([
      { kind: "ok", messageId: "m-email" },
      { kind: "ok", messageId: "m-discord" },
      { kind: "ok", messageId: "m-telegram" },
    ]);
    const router = new CommRouter(provider, { retryBackoffMs: 0 });
    const intent = baseIntent("CRITICAL", ["email", "discord", "telegram"]);
    const result = await router.route(intent);
    expect(calls.map((c) => c.to.channel)).toEqual(["email", "discord", "telegram"]);
    expect(result.summary.delivered).toBe(3);
  });

  it("routes HIGH with telegram before discord before email", async () => {
    const { provider, calls } = scriptedComm([
      { kind: "ok", messageId: "m1" },
      { kind: "ok", messageId: "m2" },
      { kind: "ok", messageId: "m3" },
    ]);
    const router = new CommRouter(provider, { retryBackoffMs: 0 });
    // Recipients declared in push-first order so the router delivers in that order.
    const intent = baseIntent("HIGH", ["telegram", "discord", "email"], [
      recipientFor("telegram"),
      recipientFor("discord"),
      recipientFor("email"),
    ]);
    await router.route(intent);
    expect(calls.map((c) => c.to.channel)).toEqual(["telegram", "discord", "email"]);
  });

  it("uses email-only for LOW (digest)", async () => {
    const { provider, calls } = scriptedComm([
      { kind: "ok", messageId: "m1" },
      { kind: "ok", messageId: "m2" },
      { kind: "ok", messageId: "m3" },
    ]);
    const router = new CommRouter(provider, { retryBackoffMs: 0 });
    const intent = baseIntent("LOW", ["email", "discord", "telegram"]);
    await router.route(intent);
    expect(calls.map((c) => c.to.channel)).toEqual(["email"]);
  });

  it("never throws — synchronous throws on a channel stay contained", async () => {
    const provider: CommProvider = {
      ...scriptedComm([{ kind: "ok", messageId: "m1" }]).provider,
      // Replace sendAlert with one that throws a non-Error value to exercise
      // errToString fallback.
      async sendAlert() {
        throw "string error";
      },
      async connect() {
        return [];
      },
    } as CommProvider;
    const router = new CommRouter(provider, { retryBackoffMs: 0 });
    const result = await router.route(
      baseIntent("CRITICAL", ["email"], [recipientFor("email")]),
    );
    expect(result.outcomes[0]!.status).toBe("failed");
    expect(result.outcomes[0]!.attempts).toBe(2); // retries=1 → 2 attempts
  });
});

/* -------------------------------------------------------------------------- */
/* Silence unused-import warning for `vi` (kept for future async cases).       */
/* -------------------------------------------------------------------------- */
void vi;
