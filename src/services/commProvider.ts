import type { Channel, Contact } from "../types/user.js";
import type { ComposedAlert } from "../types/alerts.js";

/** Connection info returned by `CommProvider.connect()`. */
export interface ChannelConnection {
  channel: Channel;
  connectionId: string;
  /** Display address (email inbox, bot username, etc.) once known. */
  address?: string;
}

/** Inbound message surfaced from a channel. */
export interface InboundMessage {
  channel: Channel;
  /** Sender's addressing (email address, Discord user id, etc.). */
  from: string;
  text: string;
  /** Optional subject (email). */
  subject?: string;
  /** Originating message id (for reply targeting). */
  messageId: string;
  /** Originating conversation id (for threading). */
  conversationId?: string;
  receivedAt: string;
}

/** Button/interaction event. */
export interface InboundInteraction {
  channel: Channel;
  from: string;
  value: string;
  sourceMessageId?: string;
  receivedAt: string;
}

/**
 * Communication provider — abstracts Caspian (and any future alternative)
 * behind a small surface. The agent core never imports the SDK directly.
 */
export interface CommProvider {
  /** One-time setup; connect any channels the user has credentials for. */
  connect(opts: {
    email?: { domain?: string };
    discord?: { botToken?: string };
    telegram?: { botToken?: string };
  }): Promise<ChannelConnection[]>;

  /**
   * Send an alert to one user on one channel.
   *
   * The implementation decides between `sendMessage` (existing conversation),
   * `initiate` (first contact), or `reply` (responding to an inbound message).
   * Returns the conversation id when known.
   */
  sendAlert(input: {
    contact: Contact;
    alert: ComposedAlert;
    /** Force a specific send path; otherwise the adapter picks. */
    path?: "sendMessage" | "initiate";
  }): Promise<{ conversationId?: string; messageId?: string }>;

  /** Register a handler for inbound user messages (acks, free-form replies). */
  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void;

  /** Register a handler for button taps / callbacks. */
  onInteraction(handler: (i: InboundInteraction) => void | Promise<void>): void;

  /** Start the receive loop. Returns when the signal aborts. */
  listen(signal: AbortSignal): Promise<void>;

  /** Serverless/webhook entrypoint. */
  handleWebhook(input: {
    body: string | Uint8Array;
    headers: Record<string, string | string[] | undefined>;
    secret: string;
  }): Promise<{ status: "ok" | "ignored" | "error"; eventId?: string | null }>;

  /** Per-channel etiquette guide for the agent's system prompt. */
  behaviorPrompt(): Promise<string>;
}
