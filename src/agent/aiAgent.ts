import { childLogger } from "../logger.js";
import type { LlmProvider } from "../services/llmProvider.js";
import {
  AgentDecision,
  type AgentConfig,
  DEFAULT_AGENT_CONFIG,
  type AgentDecision as AgentDecisionT,
} from "../types/agent.js";
import {
  type LLMSafeFactBundle,
  type NormalizedEvent,
} from "../types/events.js";
import type { User } from "../types/user.js";

const log = childLogger("agent-ai");

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

export interface DecideInput {
  event: NormalizedEvent;
  /** User(s) the agent is deciding for. Pass an empty array for broadcast. */
  users: User[];
}

/**
 * Result returned by {@link AiAgent.decide}. Carries both the decision and
 * provenance: was it produced by the LLM, by deterministic rules, or did the
 * LLM fail and we had to fall back?
 */
export interface DecideOutcome {
  decision: AgentDecisionT;
  provenance: "llm" | "rules" | "llm-fallback";
  /** Number of LLM attempts before the decision settled (0 if no LLM used). */
  attempts: number;
}

/* -------------------------------------------------------------------------- */
/* Fact bundle builder                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build the structured, fact-only bundle we hand to the LLM. We deliberately
 * strip coordinates, raw payloads, and any field the model has no business
 * inventing. The model may only rephrase what's here.
 */
function buildBundle(event: NormalizedEvent): LLMSafeFactBundle {
  return {
    id: event.id,
    source: event.source,
    sourceName: event.sourceName,
    type: event.type,
    severityLevel: event.severity.level,
    title: event.title,
    description: event.description,
    locationName: event.locationName,
    magnitude: event.magnitude,
    occurredAt: event.occurredAt,
    expectedAt: event.expectedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Prompt + parser                                                            */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = `You are an emergency communication agent.

You receive a STRUCTURED FACT BUNDLE about a verified disaster event.
You DO NOT invent facts. You DO NOT add locations, times, magnitudes, or
evacuation instructions that are not present in the bundle.

Your only job is to:
  1. Decide whether the user(s) should be alerted at all.
  2. Choose a communication priority that matches (or downgrades) the source severity.
  3. Pick a subset of the user's subscribed channels.
  4. Write a concise title and message in plain English, max ~280 chars.
  5. Provide a short reason and the canonical source URL.

You MUST respond with a single JSON object matching this shape (no prose, no
markdown, no code fences):

{
  "priority": "LOW" | "MODERATE" | "HIGH" | "CRITICAL",
  "should_alert": boolean,
  "channels": [array of subscribed channels],
  "title": string,
  "message": string,
  "reason": string,
  "source_reference": string  // must equal the canonical source URL from the bundle
}`;

function buildPrompt(
  bundle: LLMSafeFactBundle,
  user: User | undefined,
): string {
  const userBlock = user
    ? `USER (one decision for this single user):
${JSON.stringify(
  {
    id: user.id,
    name: user.name,
    subscribedChannels: user.subscribedChannels,
    locale: user.locale,
  },
  null,
  2,
)}`
    : `USER: none / broadcast.`;

  return `FACT BUNDLE (JSON, deterministic, treat as ground truth):
${JSON.stringify(bundle, null, 2)}

${userBlock}

Reply with ONLY the JSON object described in the system prompt.`;
}

/**
 * Pull the first JSON object out of a model response. Tolerates markdown
 * code fences and stray prose. Returns `null` if no parseable JSON is found.
 */
function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Strip ```json ... ``` if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence?.[1] ?? trimmed;
  // Find first balanced { ... } block.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Deterministic rules (LLM-disabled or fallback)                              */
/* -------------------------------------------------------------------------- */

const SEVERITY_TO_PRIORITY: Record<string, "LOW" | "MODERATE" | "HIGH" | "CRITICAL"> = {
  LOW: "LOW",
  MODERATE: "MODERATE",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
};

/**
 * Compute the rule-based decision. Used when:
 *   - The LLM is disabled.
 *   - The LLM failed all retries.
 *   - The event confidence is below `confidenceFloor`.
 */
function ruleBasedDecision(input: DecideInput): AgentDecisionT {
  const { event, users } = input;
  const user = users[0];
  const priority = SEVERITY_TO_PRIORITY[event.severity.level] ?? "MODERATE";
  const channels = pickChannels(priority, user);
  const shouldAlert =
    users.length > 0 && (priority === "HIGH" || priority === "CRITICAL" || priority === "MODERATE");

  const title = `[${priority}] ${humanType(event.type)} — ${truncate(event.title, 80)}`;
  const message = buildTemplateMessage(priority, event, user);
  const reason =
    priority === "LOW"
      ? "low-priority informational alert (rules-based)"
      : priority === "MODERATE"
        ? "moderate advisory (rules-based)"
        : priority === "HIGH"
          ? "high-severity alert (rules-based)"
          : "critical-severity alert (rules-based)";

  return {
    priority,
    should_alert: shouldAlert,
    channels,
    title,
    message,
    reason,
    source_reference: event.sourceUrl,
  };
}

function pickChannels(
  priority: "LOW" | "MODERATE" | "HIGH" | "CRITICAL",
  user: User | undefined,
): User["subscribedChannels"] {
  if (!user) return [];
  const subs = user.subscribedChannels;
  switch (priority) {
    case "CRITICAL":
      return subs;
    case "HIGH":
      // Prefer push channels; fall back to whatever is subscribed.
      return filterPreferred(subs, ["telegram", "discord", "email"]);
    case "MODERATE":
      return filterPreferred(subs, ["email", "discord"]);
    case "LOW":
    default:
      return filterPreferred(subs, ["email"]);
  }
}

function filterPreferred<T extends string>(
  channels: ReadonlyArray<T>,
  preferred: ReadonlyArray<T>,
): T[] {
  const set = new Set(preferred);
  const kept = channels.filter((c) => set.has(c));
  return kept.length > 0 ? [...kept] : [...channels];
}

function humanType(t: string): string {
  return t.replace(/_/g, " ");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

function buildTemplateMessage(
  priority: "LOW" | "MODERATE" | "HIGH" | "CRITICAL",
  event: NormalizedEvent,
  user: User | undefined,
): string {
  const head =
    priority === "CRITICAL"
      ? "URGENT: take action now."
      : priority === "HIGH"
        ? "Take action soon."
        : priority === "MODERATE"
          ? "Advisory: stay alert."
          : "Informational only.";
  const userLine = user ? ` Hi ${user.name}.` : "";
  const detail =
    `${event.title}\n` +
    `Source: ${event.sourceName}\n` +
    `Location: ${event.locationName ?? "near your area"}\n` +
    `Time: ${event.occurredAt}` +
    (event.expectedAt ? `\nExpected: ${event.expectedAt}` : "");
  return `${head}${userLine}\n${detail}\nFollow local guidance and check the official source for updates.`;
}

/* -------------------------------------------------------------------------- */
/* LLM-backed decision (with retries)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Call the LLM up to `maxRetries + 1` times. Each retry strengthens the
 * "no fabrication" instruction. Returns `null` on total failure so the caller
 * can fall back to the deterministic rule-based decision.
 */
async function callLlm(
  llm: LlmProvider,
  bundle: LLMSafeFactBundle,
  user: User | undefined,
  config: AgentConfig,
): Promise<{ decision: AgentDecisionT; attempts: number } | null> {
  if (!llm.enabled) return null;

  const prompt = buildPrompt(bundle, user);
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const isRetry = attempt > 0;
    const userPrompt = isRetry
      ? `${prompt}\n\nIMPORTANT: previous attempt did not produce valid JSON. ` +
        `Reply with ONLY the JSON object. Do NOT invent facts. ` +
        `priority MUST be one of LOW, MODERATE, HIGH, CRITICAL. ` +
        `source_reference MUST be the canonical source URL from the bundle.`
      : prompt;

    let text = "";
    try {
      text = (
        await withTimeout(
          llm.complete({
            system: SYSTEM_PROMPT,
            user: userPrompt,
            maxTokens: 400,
            temperature: 0.2,
          }),
          config.timeoutMs,
        )
      ).trim();
    } catch (err) {
      log.warn({ attempt, err: String(err) }, "llm call failed");
      continue;
    }
    if (!text) continue;

    const parsed = extractJson(text);
    if (parsed === null) {
      log.warn({ attempt, head: text.slice(0, 80) }, "llm output was not JSON");
      continue;
    }
    const validated = AgentDecision.safeParse(parsed);
    if (!validated.success) {
      log.warn(
        { attempt, issues: validated.error.issues.map((i) => i.message) },
        "llm output failed schema",
      );
      continue;
    }
    const d = validated.data;
    // Hard guard: priority may not exceed the source severity.
    if (!priorityAtMost(d.priority, bundle.severityLevel)) {
      log.warn(
        { attempt, llmPriority: d.priority, sourceSeverity: bundle.severityLevel },
        "llm escalated priority beyond source — discarding",
      );
      continue;
    }
    return { decision: d, attempts: attempt + 1 };
  }
  return null;
}

/** Compare two priority tiers; return true if `a` is no greater than `cap`. */
function priorityAtMost(
  a: "LOW" | "MODERATE" | "HIGH" | "CRITICAL",
  cap: "LOW" | "MODERATE" | "HIGH" | "CRITICAL",
): boolean {
  const rank: Record<string, number> = { LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };
  return (rank[a] ?? 0) <= (rank[cap] ?? 0);
}

/** Race a promise against a timeout. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`llm call timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Public class                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The AI emergency communication agent. Stateless; safe to construct per call
 * or share across calls. When `requireLlm` is false (the default) and no real
 * LLM is wired, every decision falls back to deterministic rules.
 */
export class AiAgent {
  private readonly config: AgentConfig;

  constructor(
    private readonly llm: LlmProvider,
    config: Partial<AgentConfig> = {},
  ) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
    if (this.config.requireLlm && !this.llm.enabled) {
      throw new Error(
        "AiAgent constructed with requireLlm=true but the LLM provider is disabled",
      );
    }
  }

  /**
   * Decide what (if anything) to communicate to the user(s) about this event.
   * Always returns a valid {@link AgentDecision}. Never throws.
   */
  async decide(input: DecideInput): Promise<DecideOutcome> {
    const bundle = buildBundle(input.event);
    const user = input.users[0];

    // Below confidence floor → skip the LLM entirely.
    if (
      this.config.confidenceFloor > 0 &&
      input.event.confidence < this.config.confidenceFloor
    ) {
      const decision = ruleBasedDecision(input);
      this.maybeLog("rules", 0, decision, "below confidence floor");
      return { decision, provenance: "rules", attempts: 0 };
    }

    // No users → no audience → no alert (rules-based).
    if (input.users.length === 0) {
      const decision = ruleBasedDecision(input);
      this.maybeLog("rules", 0, decision, "no users in audience");
      return { decision, provenance: "rules", attempts: 0 };
    }

    // Try the LLM. If it returns a valid decision we use it (enforcing the
    // hard guards against escalation and invented source URLs). Otherwise we
    // fall back to rules.
    if (this.llm.enabled) {
      const r = await callLlm(this.llm, bundle, user, this.config);
      if (r) {
        // Enforce canonical source URL after the model returns.
        const finalDecision: AgentDecisionT = {
          ...r.decision,
          source_reference: input.event.sourceUrl,
        };
        this.maybeLog("llm", r.attempts, finalDecision, "ok");
        return { decision: finalDecision, provenance: "llm", attempts: r.attempts };
      }
    }

    const decision = ruleBasedDecision(input);
    this.maybeLog(
      this.llm.enabled ? "llm-fallback" : "rules",
      0,
      decision,
      this.llm.enabled ? "llm failed retries — using rules" : "llm disabled — using rules",
    );
    return {
      decision,
      provenance: this.llm.enabled ? "llm-fallback" : "rules",
      attempts: 0,
    };
  }

  private maybeLog(
    provenance: "llm" | "rules" | "llm-fallback",
    attempts: number,
    decision: AgentDecisionT,
    note: string,
  ): void {
    if (!this.config.logDecisions) return;
    log.info(
      {
        provenance,
        attempts,
        priority: decision.priority,
        should_alert: decision.should_alert,
        channels: decision.channels,
        note,
      },
      "agent decision",
    );
  }
}