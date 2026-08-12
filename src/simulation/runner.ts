import { childLogger } from "../logger.js";
import { Store } from "../store/db.js";
import { upsertUser } from "../store/users.js";
import { AiAgent } from "../agent/aiAgent.js";
import { matchAudience } from "../agent/audience.js";
import { verify } from "../agent/decide.js";
import { buildRoutingIntent } from "../comm/intent.js";
import { CommRouter } from "../comm/router.js";
import type { TemplateLlm } from "../services/llmProvider.js";
import type { DiscoveredEvent } from "../services/discoveredEvent.js";
import { severityFromScore } from "../types/events.js";
import { stableId } from "../adapters/usgsSource.js";
import type { Scenario } from "./scenarios.js";
import { scenarioUsers } from "./scenarios.js";
import { MockCaspianCommProvider } from "./mockCaspian.js";

const log = childLogger("sim-runner");

export interface RunnerOutcome {
  scenarioId: string;
  eventId: string;
  severity: string;
  audienceSize: number;
  channelsDispatched: Record<string, number>;
  decisionSummary: {
    priority: string;
    should_alert: boolean;
    provenance: string;
    reason: string;
  };
  rejected: string | null;
}

/* -------------------------------------------------------------------------- */
/* Pretty-print pipeline                                                      */
/* -------------------------------------------------------------------------- */

function pipe(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = "";
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += String(values[i] ?? "");
  }
  return out;
}

function heading(text: string): string {
  return `\n=== ${text} ===`;
}

function step(text: string): string {
  return `  \u2193 ${text}`;
}

function ok(text: string): string {
  return `  \u2713 ${text}`;
}

function fail(text: string): string {
  return `  \u2717 ${text}`;
}

function joinRow(label: string, value: string): string {
  return `  ${label.padEnd(20, " ")} ${value}`;
}

/* -------------------------------------------------------------------------- */
/* Source adapter (in-memory, single scenario)                                */
/* -------------------------------------------------------------------------- */

/**
 * The simulation does not call USGS/NWS over the network. Instead we wrap a
 * single discovered event in a tiny `DisasterSource` so the ingestion path
 * really is the same code path as production: source.fetch() \u2192 source.normalize()
 * \u2192 source.validate() \u2192 recordEvent().
 */
class SimulatedSource {
  readonly name = "simulated";
  readonly sourceName: string;
  constructor(
    private readonly discovered: DiscoveredEvent,
    sourceName: string,
  ) {
    this.sourceName = sourceName;
  }

  async fetch(_sinceMs: number): Promise<DiscoveredEvent[]> {
    return [this.discovered];
  }

  normalize(d: DiscoveredEvent): import("../types/events.js").NormalizedEvent {
    const score = d.severityScore ?? 0;
    const severity = severityFromScore(score);
    return {
      id: stableId(this.name, d.externalId),
      source: this.name,
      externalId: d.externalId,
      sourceName: this.sourceName,
      sourceUrl: d.sourceUrl,
      type: d.type,
      severity,
      confidence: d.confidence ?? 0.7,
      title: d.title,
      description: d.description ?? "",
      locationName: d.locationName,
      location: d.location,
      affectedRegion: {
        kind: "radius",
        center: d.location,
        radiusKm: d.radiusKm ?? 100,
      },
      magnitude: d.magnitude,
      occurredAt: d.occurredAt,
      observedAt: new Date().toISOString(),
      expectedAt: d.expectedAt,
      raw: undefined,
    };
  }

  validate(ev: import("../types/events.js").NormalizedEvent): import("../services/disasterSource.js").ValidationResult {
    return { ok: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Pipeline driver                                                            */
/* -------------------------------------------------------------------------- */

export interface RunOptions {
  llm: TemplateLlm;
  /** When true, prints the ASCII pipeline to stdout. */
  verbose?: boolean;
}

export async function runScenario(
  scenario: Scenario,
  opts: RunOptions,
): Promise<RunnerOutcome> {
  const v = opts.verbose ?? true;
  const print = (s: string): void => {
    if (v) process.stdout.write(s + "\n");
  };

  print(heading(scenario.label));
  print(pipe`  EVENT ID          ${scenario.discovered.externalId}`);
  print(pipe`  TYPE              ${scenario.discovered.type}`);
  print(pipe`  EXPECTED          ${scenario.discovered.expectedAt ?? "now"}`);
  print(step("EVENT DETECTED"));
  print(step("SOURCE VERIFIED (simulated source: deterministic)"));

  // 1. Inception: open an in-memory store, seed users exactly as production.
  const store = await Store.open(":memory:");
  const users = scenarioUsers(scenario);
  for (const u of users) upsertUser(store, u);

  // 2. Run the source the same way runOnce does.
  const source = new SimulatedSource(scenario.discovered, scenario.discovered.sourceName);
  let discovered: DiscoveredEvent[];
  try {
    discovered = await source.fetch(0);
  } catch (err) {
    print(fail(`source fetch failed: ${String(err)}`));
    log.warn({ err: String(err) }, "simulated source fetch failed");
    return {
      scenarioId: scenario.id,
      eventId: "",
      severity: "unknown",
      audienceSize: 0,
      channelsDispatched: {},
      decisionSummary: {
        priority: "UNKNOWN",
        should_alert: false,
        provenance: "rules",
        reason: "fetch failed",
      },
      rejected: "fetch failed",
    };
  }
  if (discovered.length === 0) {
    print(fail("source returned no events"));
    return {
      scenarioId: scenario.id,
      eventId: "",
      severity: "unknown",
      audienceSize: 0,
      channelsDispatched: {},
      decisionSummary: {
        priority: "UNKNOWN",
        should_alert: false,
        provenance: "rules",
        reason: "no events",
      },
      rejected: "no events",
    };
  }

  const d = discovered[0]!;
  const ev = source.normalize(d);
  const sourceValid = source.validate(ev);
  const verifyResult = verify(ev);
  if (!verifyResult.ok || !sourceValid.ok) {
    print(
      fail(
        `verification failed: ${verifyResult.reason ?? sourceValid.reason ?? "unknown"}`,
      ),
    );
    return {
      scenarioId: scenario.id,
      eventId: ev.id,
      severity: ev.severity.level,
      audienceSize: 0,
      channelsDispatched: {},
      decisionSummary: {
        priority: "UNKNOWN",
        should_alert: false,
        provenance: "rules",
        reason: verifyResult.reason ?? "rejected",
      },
      rejected: verifyResult.reason ?? "rejected",
    };
  }

  print(ok(`event verified (severity=${ev.severity.level})`));
  print(joinRow("SEVERITY:", ev.severity.level));

  // 3. Match audience \u2014 the real `matchAudience` from the production tree.
  const audience = matchAudience({ event: ev, users });
  print(joinRow("AFFECTED USERS:", String(audience.length)));

  const receivedUsers = audience.map((a) => a.user);
  if (receivedUsers.length === 0) {
    print(fail("no users in audience \u2014 nothing to do"));
    return {
      scenarioId: scenario.id,
      eventId: ev.id,
      severity: ev.severity.level,
      audienceSize: 0,
      channelsDispatched: {},
      decisionSummary: {
        priority: ev.severity.level,
        should_alert: false,
        provenance: "rules",
        reason: "no-audience",
      },
      rejected: "no audience",
    };
  }

  // 4. Invoke the agent \u2014 the real `AiAgent` class.
  const agent = new AiAgent(opts.llm);
  const agentOutcome = await agent.decide({ event: ev, users: receivedUsers });
  print(step("AGENT DECISION"));
  print(joinRow("PROVENANCE:", agentOutcome.provenance));
  print(joinRow("PRIORITY:", agentOutcome.decision.priority));
  print(joinRow("SHOULD ALERT:", String(agentOutcome.decision.should_alert)));
  print(joinRow("REASON:", agentOutcome.decision.reason));

  // 5. Build the routing intent \u2014 the same builder the production entrypoint uses.
  const intent = buildRoutingIntent({
    event: ev,
    decision: agentOutcome.decision,
    users: receivedUsers,
    retries: 1,
  });

  // 6. Route through the real `CommRouter` + a mock Caspian provider.
  const comm = new MockCaspianCommProvider();
  await comm.connect({
    email: { domain: "demo.aegis.ai" },
    discord: { botToken: "mock" },
    telegram: { botToken: "mock" },
  });

  const channelsDispatched: Record<string, number> = {};
  if (!intent) {
    print(fail("agent declined the alert"));
    return {
      scenarioId: scenario.id,
      eventId: ev.id,
      severity: ev.severity.level,
      audienceSize: receivedUsers.length,
      channelsDispatched,
      decisionSummary: {
        priority: agentOutcome.decision.priority,
        should_alert: agentOutcome.decision.should_alert,
        provenance: agentOutcome.provenance,
        reason: agentOutcome.decision.reason,
      },
      rejected: "agent declined",
    };
  }

  const router = new CommRouter(comm, {
    perAttemptTimeoutMs: 100,
    retryBackoffMs: 0,
    onOutcome: (o) => {
      // The router fires a "sending" transition before the terminal outcome.
      // For the demo we only want the final per-channel line, not the noise.
      if (o.status === "sending") return;
      const label = `${o.channel.toUpperCase()}: ${
        o.status === "delivered" || o.status === "sent" ? "SENT" : o.status.toUpperCase()
      }`;
      print(ok(label));
      channelsDispatched[o.channel] = (channelsDispatched[o.channel] ?? 0) + 1;
    },
  });

  const result = await router.route(intent);
  print("");
  print(pipe`  ROUTER SUMMARY   delivered=${result.summary.delivered}  failed=${result.summary.failed}  skipped=${result.summary.skipped}`);

  await store.close();

  return {
    scenarioId: scenario.id,
    eventId: ev.id,
    severity: ev.severity.level,
    audienceSize: receivedUsers.length,
    channelsDispatched,
    decisionSummary: {
      priority: agentOutcome.decision.priority,
      should_alert: agentOutcome.decision.should_alert,
      provenance: agentOutcome.provenance,
      reason: agentOutcome.decision.reason,
    },
    rejected: null,
  };
}
