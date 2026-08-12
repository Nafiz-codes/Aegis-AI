import { z } from "zod";
import { Channel } from "./user.js";
import { SEVERITY_TIERS } from "./events.js";

/**
 * Public decision shape returned by the AI communication agent.
 *
 * The contract is intentionally narrow:
 *  - `priority` mirrors the source event severity tier (the agent may NOT
 *    fabricate a higher or lower tier than what the provider reported;
 *    at most it can downgrade on low confidence or irrelevance).
 *  - `should_alert` is the agent's "is this worth a notification?" judgement.
 *  - `channels` is a subset of the user's subscribed channels.
 *  - `title` / `message` are facts-only user-facing copy. The agent is
 *    forbidden from inventing locations, times, magnitudes, or evacuation
 *    instructions. `message` MUST be concise and actionable.
 *  - `reason` is the short machine-readable explanation (free text but short).
 *  - `source_reference` is the canonical URL the user can check for ground
 *    truth — always taken from the source event, never invented.
 */
export const AgentPriority = z.enum(SEVERITY_TIERS);
export type AgentPriority = z.infer<typeof AgentPriority>;

export const AgentDecision = z.object({
  priority: AgentPriority,
  should_alert: z.boolean(),
  channels: z.array(Channel).max(8),
  title: z.string().min(1).max(120),
  message: z.string().min(1).max(1000),
  reason: z.string().min(1).max(280),
  source_reference: z.string().url(),
});
export type AgentDecision = z.infer<typeof AgentDecision>;

/** Wire-protocol view (snake_case) for downstream JSON consumers. */
export const AgentDecisionWire = AgentDecision.extend({});
export type AgentDecisionWire = z.infer<typeof AgentDecisionWire>;

/**
 * Configuration for {@link AiAgent}. Pure data; safe to instantiate at module
 * load without an API key — the LLM is optional and the agent falls back to a
 * deterministic rule-based decision when no provider is configured.
 */
export interface AgentConfig {
  /** When true the agent requires a real LLM provider; otherwise it throws. */
  requireLlm: boolean;
  /** Maximum retries on transient failure (network, parse, schema). */
  maxRetries: number;
  /** Per-call timeout in ms — passed through to the LLM provider. */
  timeoutMs: number;
  /** Minimum confidence required to call the LLM (below = rule-based fallback). */
  confidenceFloor: number;
  /** If true, the agent logs each decision. */
  logDecisions: boolean;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  requireLlm: false,
  maxRetries: 2,
  timeoutMs: 15_000,
  confidenceFloor: 0,
  logDecisions: true,
};
