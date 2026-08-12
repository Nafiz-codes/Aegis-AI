import { childLogger } from "../logger.js";
import type {
  ChannelConnection,
  CommProvider,
  InboundInteraction,
  InboundMessage,
} from "../services/commProvider.js";
import type { Channel, Contact } from "../types/user.js";
import type { ComposedAlert } from "../types/alerts.js";
import type { DeliveryOutcome } from "../comm/types.js";

const log = childLogger("mock-caspian");

/**
 * Offline deterministic {@link CommProvider} used by the demo / simulation
 * mode. Every `sendAlert` call is recorded so the runner can print a faithful
 * transcript; no real Caspian API is touched.
 *
 * Behaviour matches the real {@link CaspianCommProvider} at the shape level:
 *   - `sendAlert` returns a synthetic conversationId + messageId.
 *   - `connect` returns synthetic `ChannelConnection` rows per channel.
 *   - Listeners are stored but never invoked (we do not simulate inbound).
 */
export interface MockSend {
  to: Contact;
  alert: ComposedAlert;
  conversationId: string;
  messageId: string;
  at: string;
}

export class MockCaspianCommProvider implements CommProvider {
  readonly sends: MockSend[] = [];
  private readonly connectionsByChannel = new Map<Channel, ChannelConnection>();
  private readonly messageHandlers: Array<
    (m: InboundMessage) => void | Promise<void>
  > = [];
  private readonly interactionHandlers: Array<
    (i: InboundInteraction) => void | Promise<void>
  > = [];

  async connect(opts: {
    email?: { domain?: string };
    discord?: { botToken?: string };
    telegram?: { botToken?: string };
  }): Promise<ChannelConnection[]> {
    const out: ChannelConnection[] = [];
    if (opts.email !== undefined) {
      const conn: ChannelConnection = {
        channel: "email",
        connectionId: `mock-email-${Date.now()}`,
        address: opts.email.domain ?? "demo.aegis.ai",
      };
      this.connectionsByChannel.set("email", conn);
      out.push(conn);
    }
    if (opts.discord?.botToken) {
      const conn: ChannelConnection = {
        channel: "discord",
        connectionId: `mock-discord-${Date.now()}`,
      };
      this.connectionsByChannel.set("discord", conn);
      out.push(conn);
    }
    if (opts.telegram?.botToken) {
      const conn: ChannelConnection = {
        channel: "telegram",
        connectionId: `mock-telegram-${Date.now()}`,
      };
      this.connectionsByChannel.set("telegram", conn);
      out.push(conn);
    }
    log.info(
      { connected: out.map((c) => c.channel) },
      "mock caspian: channels connected",
    );
    return out;
  }

  async sendAlert(input: {
    contact: Contact;
    alert: ComposedAlert;
    path?: "sendMessage" | "initiate";
  }): Promise<{ conversationId?: string; messageId?: string }> {
    const conversationId = `conv-${this.sends.length + 1}-${input.contact.channel}`;
    const messageId = `msg-${this.sends.length + 1}-${Date.now()}`;
    this.sends.push({
      to: input.contact,
      alert: input.alert,
      conversationId,
      messageId,
      at: new Date().toISOString(),
    });
    return { conversationId, messageId };
  }

  /** Build the DeliveryOutcome list the runner needs to print. */
  buildOutcomes(): DeliveryOutcome[] {
    return this.sends.map((s, i) => ({
      recipient: s.to.address,
      channel: s.to.channel,
      status: "delivered",
      attempts: 1,
      conversationId: s.conversationId,
      messageId: s.messageId,
    }));
  }

  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.messageHandlers.push(handler);
  }
  onInteraction(handler: (i: InboundInteraction) => void | Promise<void>): void {
    this.interactionHandlers.push(handler);
  }
  async listen(_signal: AbortSignal): Promise<void> {
    // No inbound traffic in demo mode. Sleep until aborted.
    return new Promise((resolve) => {
      _signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async handleWebhook(): Promise<{ status: "ok" | "ignored" | "error"; eventId?: string | null }> {
    return { status: "ignored" };
  }
  async behaviorPrompt(): Promise<string> {
    return "You are Aegis AI. Demo mode: behaviour prompt returned by mock provider.";
  }
}
