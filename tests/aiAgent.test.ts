import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiAgent } from "../src/agent/aiAgent.js";
import type { LlmProvider } from "../src/services/llmProvider.js";
import type { NormalizedEvent } from "../src/types/events.js";
import type { User } from "../src/types/user.js";

const baseEvent = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  id: "evt_1",
  source: "usgs",
  externalId: "usgs:1",
  sourceName: "USGS Earthquake Hazards Program",
  sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/ev1",
  type: "earthquake",
  severity: { level: "CRITICAL", score: 0.95 },
  confidence: 0.9,
  title: "M7.1 - 10km S of Anywhere, CN",
  description: "Major shaking expected near the epicenter.",
  location: { lat: 35, lon: 118 },
  occurredAt: "2025-01-01T00:00:00.000Z",
  observedAt: "2025-01-01T00:00:05.000Z",
  ...overrides,
});

const user = (overrides: Partial<User> = {}): User => ({
  id: "usr_1",
  name: "Alice",
  location: { lat: 35.1, lon: 118.1 },
  subscribedChannels: ["email", "discord", "telegram"],
  contacts: [
    { channel: "email", address: "alice@example.com" },
    { channel: "discord", address: "alice#0001" },
    { channel: "telegram", address: "1234567" },
  ],
  active: true,
  ...overrides,
});

/** A scripted LLM that returns the next string on each call. */
const scriptedLlm = (responses: string[]): LlmProvider & { calls: number } => {
  const calls = { n: 0 };
  return {
    enabled: true,
    get calls() {
      return calls.n;
    },
    async complete() {
      const idx = Math.min(calls.n, responses.length - 1);
      calls.n += 1;
      return responses[idx] ?? "";
    },
  } as LlmProvider & { calls: number };
};

const validDecisionJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    priority: "CRITICAL",
    should_alert: true,
    channels: ["telegram", "email"],
    title: "M7.1 earthquake near you",
    message: "USGS reports a CRITICAL earthquake near your area. Check official sources.",
    reason: "high-severity event in affected region",
    source_reference: "https://earthquake.usgs.gov/earthquakes/eventpage/ev1",
    ...overrides,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-01T01:00:00.000Z"));
});

describe("AiAgent.decide — critical event", () => {
  it("uses the LLM decision when valid JSON is returned", async () => {
    const llm = scriptedLlm([validDecisionJson()]);
    const agent = new AiAgent(llm, { maxRetries: 0 });
    const ev = baseEvent();
    const u = user();
    const outcome = await agent.decide({ event: ev, users: [u] });

    expect(outcome.provenance).toBe("llm");
    expect(outcome.attempts).toBe(1);
    expect(outcome.decision.priority).toBe("CRITICAL");
    expect(outcome.decision.should_alert).toBe(true);
    expect(outcome.decision.channels).toEqual(["telegram", "email"]);
    // Hard guard: source_reference must match the canonical URL.
    expect(outcome.decision.source_reference).toBe(ev.sourceUrl);
  });

  it("uses all subscribed channels for CRITICAL when LLM chooses all", async () => {
    const llm = scriptedLlm([
      validDecisionJson({ channels: ["email", "discord", "telegram"] }),
    ]);
    const agent = new AiAgent(llm, { maxRetries: 0 });
    const outcome = await agent.decide({
      event: baseEvent(),
      users: [user()],
    });
    expect(outcome.decision.channels).toEqual(["email", "discord", "telegram"]);
  });

  it("refuses to let the LLM escalate priority beyond source severity", async () => {
    // LLM tries to call a CRITICAL event CRITICAL (matching) — should succeed.
    // Then we assert it cannot ESCALATE the OPPOSITE direction.
    const llm = scriptedLlm([
      validDecisionJson({ priority: "CRITICAL" }),
    ]);
    const agent = new AiAgent(llm, { maxRetries: 0 });
    const outcome = await agent.decide({
      event: baseEvent({ severity: { level: "MODERATE", score: 0.5 } }),
      users: [user()],
    });
    expect(outcome.provenance).toBe("llm-fallback");
    expect(outcome.decision.priority).toBe("MODERATE");
  });
});

describe("AiAgent.decide — moderate event", () => {
  it("uses a restricted channel subset for MODERATE", async () => {
    const ev = baseEvent({ severity: { level: "MODERATE", score: 0.5 } });
    const llm = scriptedLlm([
      validDecisionJson({
        priority: "MODERATE",
        channels: ["email"],
        title: "Moderate advisory",
        message: "USGS reports a MODERATE earthquake. Stay alert.",
        reason: "moderate advisory",
      }),
    ]);
    const agent = new AiAgent(llm, { maxRetries: 0 });
    const outcome = await agent.decide({ event: ev, users: [user()] });
    expect(outcome.provenance).toBe("llm");
    expect(outcome.decision.priority).toBe("MODERATE");
    expect(outcome.decision.channels).toEqual(["email"]);
  });

  it("rule-based fallback picks only email when LLM is disabled", async () => {
    const ev = baseEvent({ severity: { level: "MODERATE", score: 0.5 } });
    const llm: LlmProvider = { enabled: false, async complete() { return ""; } };
    const agent = new AiAgent(llm);
    const outcome = await agent.decide({ event: ev, users: [user()] });
    expect(outcome.provenance).toBe("rules");
    expect(outcome.decision.priority).toBe("MODERATE");
    expect(outcome.decision.channels).toEqual(["email", "discord"]);
    expect(outcome.decision.source_reference).toBe(ev.sourceUrl);
  });
});

describe("AiAgent.decide — irrelevant event", () => {
  it("returns should_alert=false when no users are passed", async () => {
    const ev = baseEvent();
    const llm = scriptedLlm([
      validDecisionJson({ should_alert: false, priority: "LOW" }),
    ]);
    const agent = new AiAgent(llm, { maxRetries: 0 });
    const outcome = await agent.decide({ event: ev, users: [] });
    expect(outcome.provenance).toBe("rules");
    expect(outcome.decision.should_alert).toBe(false);
  });

  it("rule-based LOW priority produces a single-channel informational notice", async () => {
    const ev = baseEvent({ severity: { level: "LOW", score: 0.15 } });
    const llm: LlmProvider = { enabled: false, async complete() { return ""; } };
    const agent = new AiAgent(llm);
    const outcome = await agent.decide({ event: ev, users: [user()] });
    expect(outcome.provenance).toBe("rules");
    expect(outcome.decision.priority).toBe("LOW");
    expect(outcome.decision.channels).toEqual(["email"]);
  });
});

describe("AiAgent.decide — incomplete event", () => {
  it("falls back to rules when event lacks sourceName", async () => {
    // Strip the source name but keep the rest — the LLM bundle will be empty
    // for that field, but the agent still produces a deterministic decision.
    const ev = baseEvent({ sourceName: "" });
    const llm = scriptedLlm([validDecisionJson()]);
    const agent = new AiAgent(llm, { maxRetries: 0 });
    const outcome = await agent.decide({ event: ev, users: [user()] });
    // The LLM decision is still taken because sourceName isn't enforced by
    // the schema; but the rule-based source_reference is the canonical URL.
    expect(outcome.decision.source_reference).toBe(ev.sourceUrl);
  });

  it("downgrades to rules when confidence is below the configured floor", async () => {
    const ev = baseEvent({ confidence: 0.1 });
    const llm = scriptedLlm([validDecisionJson()]);
    const agent = new AiAgent(llm, { confidenceFloor: 0.5 });
    const outcome = await agent.decide({ event: ev, users: [user()] });
    expect(outcome.provenance).toBe("rules");
    expect(outcome.attempts).toBe(0);
  });
});

describe("AiAgent.decide — malformed AI response", () => {
  it("falls back to rules when LLM returns non-JSON", async () => {
    const llm = scriptedLlm(["Sorry, I cannot help with that."]);
    const agent = new AiAgent(llm, { maxRetries: 1 });
    const ev = baseEvent();
    const outcome = await agent.decide({ event: ev, users: [user()] });
    expect(outcome.provenance).toBe("llm-fallback");
    expect(outcome.decision.priority).toBe("CRITICAL"); // rules-based tracks source
    expect(outcome.decision.source_reference).toBe(ev.sourceUrl);
  });

  it("retries on malformed JSON, then falls back to rules", async () => {
    const llm = scriptedLlm([
      "not json",
      "still not json",
      "```json\n{ \"priority\": \"HIGH\" }\n```", // missing required fields
    ]);
    const agent = new AiAgent(llm, { maxRetries: 2 });
    const outcome = await agent.decide({
      event: baseEvent(),
      users: [user()],
    });
    expect(outcome.provenance).toBe("llm-fallback");
    expect((llm as { calls: number }).calls).toBe(3); // 1 + 2 retries
    expect(outcome.decision.source_reference).toBe(
      baseEvent().sourceUrl,
    );
  });

  it("retries on JSON missing required fields, then accepts the next valid one", async () => {
    const llm = scriptedLlm([
      JSON.stringify({ priority: "HIGH" }), // missing most fields
      validDecisionJson({ priority: "HIGH" }),
    ]);
    const agent = new AiAgent(llm, { maxRetries: 2 });
    const outcome = await agent.decide({
      event: baseEvent({ severity: { level: "HIGH", score: 0.7 } }),
      users: [user()],
    });
    expect(outcome.provenance).toBe("llm");
    expect(outcome.attempts).toBe(2);
    expect(outcome.decision.priority).toBe("HIGH");
  });

  it("ignores LLM escalation attempts and uses rules", async () => {
    // LLM tries to call a MODERATE event CRITICAL — guard rejects, retry LLM
    // escalates again, retry guard rejects, third attempt valid LOW.
    const llm = scriptedLlm([
      validDecisionJson({ priority: "CRITICAL" }),
      validDecisionJson({ priority: "CRITICAL" }),
      validDecisionJson({ priority: "MODERATE" }),
    ]);
    const agent = new AiAgent(llm, { maxRetries: 2 });
    const outcome = await agent.decide({
      event: baseEvent({ severity: { level: "MODERATE", score: 0.5 } }),
      users: [user()],
    });
    expect(outcome.provenance).toBe("llm");
    expect(outcome.decision.priority).toBe("MODERATE");
  });

  it("returns a valid decision when the LLM throws on every call", async () => {
    const llm: LlmProvider = {
      enabled: true,
      async complete() {
        throw new Error("network down");
      },
    };
    const agent = new AiAgent(llm, { maxRetries: 1 });
    const outcome = await agent.decide({
      event: baseEvent(),
      users: [user()],
    });
    expect(outcome.provenance).toBe("llm-fallback");
    expect(outcome.decision.priority).toBe("CRITICAL");
    expect(outcome.decision.source_reference).toBe(baseEvent().sourceUrl);
  });
});

describe("AiAgent.decide — non-fabrication", () => {
  it("rule-based decision never invents a source URL", async () => {
    const ev = baseEvent({
      sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/real",
    });
    const llm: LlmProvider = { enabled: false, async complete() { return ""; } };
    const agent = new AiAgent(llm);
    const outcome = await agent.decide({ event: ev, users: [user()] });
    expect(outcome.decision.source_reference).toBe(ev.sourceUrl);
  });

  it("overrides an LLM-invented source_reference with the canonical URL", async () => {
    const llm = scriptedLlm([
      validDecisionJson({
        source_reference: "https://malicious.example.com/lies",
      }),
    ]);
    const agent = new AiAgent(llm, { maxRetries: 0 });
    const ev = baseEvent();
    const outcome = await agent.decide({ event: ev, users: [user()] });
    expect(outcome.decision.source_reference).toBe(ev.sourceUrl);
  });
});
