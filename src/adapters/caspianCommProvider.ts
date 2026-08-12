import { CommClient, type Connection } from "caspian-sdk";
import { childLogger } from "../logger.js";
import type {
  ChannelConnection,
  CommProvider,
  InboundInteraction,
  InboundMessage,
} from "../services/commProvider.js";
import type { Channel, Contact } from "../types/user.js";
import type { ComposedAlert } from "../types/alerts.js";

const log = childLogger("caspian-adapter");

/**
 * Raised when we want to call a Caspian capability but have not yet verified
 * that the gateway grants it for a fresh API key. Callers should handle
 * gracefully (e.g. fall back to a different channel).
 */
export class UnverifiedCapabilityError extends Error {
  constructor(
    public readonly capability: string,
    public readonly channel: Channel,
    message?: string,
  ) {
    super(
      message ??
        `Caspian capability "${capability}" on "${channel}" is not yet verified for this API key — handle gracefully.`,
    );
    this.name = "UnverifiedCapabilityError";
  }
}

interface CaspianCommProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

export class CaspianCommProvider implements CommProvider {
  private readonly client: CommClient;
  private readonly messageHandlers: Array<(m: InboundMessage) => void | Promise<void>> = [];
  private readonly interactionHandlers: Array<(i: InboundInteraction) => void | Promise<void>> = [];

  constructor(opts: CaspianCommProviderOptions) {
    this.client = new CommClient({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    });

    // Verified SDK methods — register once at construction.
    this.client.onMessage(async (msg) => {
      const inbound: InboundMessage = {
        channel: this.mapChannel(msg.channel),
        from: String(msg.sender?.["email"] ?? msg.sender?.["id"] ?? ""),
        text: msg.text ?? "",
        subject: msg.subject ?? undefined,
        messageId: msg.id,
        conversationId: msg.conversationId,
        receivedAt: new Date().toISOString(),
      };
      for (const h of this.messageHandlers) {
        await h(inbound);
      }
    });

    this.client.onInteraction(async (i) => {
      const inbound: InboundInteraction = {
        channel: this.mapChannel(i.sourceMessage?.["channel"] ?? "email"),
        from: String(i.sender?.["email"] ?? i.sender?.["id"] ?? ""),
        value: i.value ?? "",
        sourceMessageId: undefined,
        receivedAt: new Date().toISOString(),
      };
      for (const h of this.interactionHandlers) {
        await h(inbound);
      }
    });
  }

  async connect(opts: {
    email?: { domain?: string };
    discord?: { botToken?: string };
    telegram?: { botToken?: string };
  }): Promise<ChannelConnection[]> {
    const out: ChannelConnection[] = [];

    if (opts.email !== undefined) {
      const conn = await this.client.connectEmail({
        domain: opts.email.domain,
        wait: true,
      });
      out.push(this.toChannelConnection("email", conn));
    }

    if (opts.discord?.botToken) {
      const conn = await this.client.connectDiscord({
        botToken: opts.discord.botToken,
        wait: true,
      });
      out.push(this.toChannelConnection("discord", conn));
    }

    if (opts.telegram?.botToken) {
      const conn = await this.client.connectTelegram({
        botToken: opts.telegram.botToken,
        wait: true,
      });
      out.push(this.toChannelConnection("telegram", conn));
    }

    log.info({ connected: out.map((c) => c.channel) }, "channels connected");
    return out;
  }

  async sendAlert(input: {
    contact: Contact;
    alert: ComposedAlert;
    path?: "sendMessage" | "initiate";
  }): Promise<{ conversationId?: string; messageId?: string }> {
    const { contact, alert } = input;

    // Email goes through sendMessage with a known connection id. For
    // Discord/Telegram without a stored conversationId we use initiate().
    if (contact.channel === "email") {
      if (!contact.connectionId) {
        throw new UnverifiedCapabilityError(
          "Capability.SEND",
          "email",
          "No connectionId stored for email contact — connect() must populate it.",
        );
      }
      const result = await this.client.sendMessage(
        contact.connectionId,
        alert.text,
        null,
        null,
        null,
      );
      return {
        conversationId: typeof result["conversationId"] === "string"
          ? (result["conversationId"] as string)
          : undefined,
        messageId: typeof result["messageId"] === "string"
          ? (result["messageId"] as string)
          : undefined,
      };
    }

    // For chat channels we need a conversation id. If we have one, use
    // sendMessage; otherwise fall back to initiate to cold-start the user.
    if (contact.connectionId && input.path !== "initiate") {
      const result = await this.client.sendMessage(
        contact.connectionId,
        alert.text,
        null,
        alert.blocks as never,
        null,
      );
      return {
        conversationId: typeof result["conversationId"] === "string"
          ? (result["conversationId"] as string)
          : undefined,
        messageId: typeof result["messageId"] === "string"
          ? (result["messageId"] as string)
          : undefined,
      };
    }

    // Cold-start path. `Capability.INITIATE` is needed; on a fresh key we are
    // not yet sure which channels grant it — throw so the caller can decide
    // to fall back to email.
    try {
      const result = await this.client.initiate(
        contact.connectionId ?? "",
        contact.address,
        alert.text,
      );
      return {
        conversationId: typeof result["conversationId"] === "string"
          ? (result["conversationId"] as string)
          : undefined,
        messageId: typeof result["messageId"] === "string"
          ? (result["messageId"] as string)
          : undefined,
      };
    } catch (err) {
      const status =
        err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode: number }).statusCode
          : 0;
      if (status === 401 || status === 403) {
        throw new UnverifiedCapabilityError(
          "Capability.INITIATE",
          contact.channel,
        );
      }
      throw err;
    }
  }

  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onInteraction(handler: (i: InboundInteraction) => void | Promise<void>): void {
    this.interactionHandlers.push(handler);
  }

  async listen(signal: AbortSignal): Promise<void> {
    await this.client.listen({ signal });
  }

  async handleWebhook(input: {
    body: string | Uint8Array;
    headers: Record<string, string | string[] | undefined>;
    secret: string;
  }): Promise<{ status: "ok" | "ignored" | "error"; eventId?: string | null }> {
    const result = await this.client.handleWebhook({
      body: input.body,
      headers: input.headers,
      secret: input.secret,
    });
    return {
      status: result.status,
      eventId: result.eventId ?? undefined,
    };
  }

  async behaviorPrompt(): Promise<string> {
    return this.client.behaviorPrompt();
  }

  /** Direct access for callers that need it (e.g. listing connections). */
  get raw(): CommClient {
    return this.client;
  }

  private toChannelConnection(channel: Channel, conn: Connection): ChannelConnection {
    return {
      channel,
      connectionId: conn.id,
      address: conn.address,
    };
  }

  private mapChannel(sdkChannel: string): Channel {
    switch (sdkChannel) {
      case "email":
        return "email";
      case "discord":
        return "discord";
      case "telegram":
        return "telegram";
      default:
        // Unknown channel — default to email so handlers can still process it.
        return "email";
    }
  }
}
