import type { AgentDecision } from "../types/agent.js";
import type { NormalizedEvent } from "../types/events.js";
import type { User } from "../types/user.js";
import type {
  AlertContent,
  Recipient,
  RoutingIntent,
  RoutingPriority,
} from "./types.js";

/**
 * Translate one (event, decision, user-list) triple into a single
 * {@link RoutingIntent}. The agent has already decided priority / channels /
 * message; this adapter just reshapes the data for the router.
 */
export function buildRoutingIntent(input: {
  event: NormalizedEvent;
  decision: AgentDecision;
  users: User[];
  retries?: number;
}): RoutingIntent | null {
  const { event, decision, users } = input;

  if (!decision.should_alert) return null;

  const recipients: Recipient[] = [];
  for (const u of users) {
    for (const ch of decision.channels) {
      const contact = u.contacts.find((c) => c.channel === ch);
      if (!contact) continue;
      recipients.push({
        channel: ch,
        name: u.name,
        address: contact.address,
        connectionId: contact.connectionId,
      });
    }
  }

  if (recipients.length === 0) return null;

  const content: AlertContent = {
    title: decision.title,
    body: decision.message,
    subject: `${decision.priority} alert — ${event.title}`,
    sourceReference: decision.source_reference,
    sourceName: event.sourceName,
  };

  return {
    eventId: event.id,
    priority: decision.priority as RoutingPriority,
    channels: [...decision.channels],
    content,
    recipients,
    retries: input.retries ?? 2,
  };
}