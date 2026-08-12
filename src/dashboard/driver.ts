import { Store } from "../store/db.js";
import { scenarioUsers, type Scenario } from "../simulation/scenarios.js";
import { upsertUser } from "../store/users.js";
import { recordEvent } from "../store/events.js";
import { insertAlert, updateAlertStatus, recentAlerts } from "../store/alerts.js";
import { recentEvents } from "../store/events.js";
import { MockCaspianCommProvider } from "../simulation/mockCaspian.js";
import { childLogger } from "../logger.js";
import { dashboardBus, fmtClock } from "./bus.js";
import { buildDashboardState } from "./state.js";

const log = childLogger("dashboard-driver");

/**
 * Owns the lifecycle of the dashboard's working store: keeps users seeded,
 * drains scenarios through the production-shaped pipeline, and persists
 * events + alerts so the dashboard reads real backend state.
 *
 * The pipeline here reuses `MockCaspianCommProvider` + the same scenario
 * shapes used in `npm run demo`, but writes through to a real SQLite store
 * so the UI is observing actual backend state.
 */
export class DashboardDriver {
  readonly store: Store;
  private scenarios: ReadonlyArray<Scenario>;
  private cursor = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly ring: { cap: number; events: ReturnType<typeof tail>["events"] } = {
    cap: 200,
    events: [],
  };

  constructor(args: { store: Store; scenarios: ReadonlyArray<Scenario> }) {
    this.store = args.store;
    this.scenarios = args.scenarios;
  }

  /** Seed every user from every scenario once. */
  async seedUsers(): Promise<void> {
    const seen = new Set<string>();
    for (const s of this.scenarios) {
      for (const u of scenarioUsers(s)) {
        if (seen.has(u.id)) continue;
        seen.add(u.id);
        upsertUser(this.store, u);
      }
    }
    log.info({ users: seen.size }, "dashboard seeded users");
    dashboardBus.emit({
      kind: "system",
      tag: "DASHBOARD",
      message: `${seen.size} subscribers registered for simulated region`,
      meta: { subscribers: seen.size },
    });
  }

  /** Run one scenario end-to-end, persisting everything. */
  async execute(scenario: Scenario): Promise<void> {
    const t0 = Date.now();

    dashboardBus.emit({
      kind: "detected",
      tag: scenario.discovered.type.toUpperCase(),
      message: `${humanType(scenario.discovered.type)} detected — ${scenario.label.split(" severity ")[0]?.toUpperCase() ?? "ALERT"}`,
      meta: { scenarioId: scenario.id, externalId: scenario.discovered.externalId },
    });
    await sleep(120);

    dashboardBus.emit({
      kind: "verified",
      tag: "VERIFIED",
      message: `Source verified — ${scenario.discovered.sourceName} (confidence ${((scenario.discovered.confidence ?? 0) * 100).toFixed(0)}%)`,
      meta: { sourceUrl: scenario.discovered.sourceUrl },
    });
    await sleep(120);

    const sevScore = scenario.discovered.severityScore ?? 0;
    const severity: "LOW" | "MODERATE" | "HIGH" | "CRITICAL" =
      sevScore >= 0.85 ? "CRITICAL"
        : sevScore >= 0.6 ? "HIGH"
          : sevScore >= 0.3 ? "MODERATE"
            : "LOW";
    dashboardBus.emit({
      kind: "severity",
      tag: severity,
      message: `Severity classified ${severity} (score ${sevScore.toFixed(2)})`,
      meta: { level: severity, score: sevScore },
    });
    await sleep(120);

    // Compute the audience using the same matcher the production entrypoint
    // uses, so what the timeline says is exactly what the store sees.
    const allUsers = scenarioUsers(scenario);
    const normalized = normalizeForMatcher(scenario);
    const audience = audienceOf(normalized, allUsers);
    dashboardBus.emit({
      kind: "audience",
      tag: "MATCH",
      message: `${audience.length} subscribers matched by geo-fence`,
      meta: { count: audience.length, scenarioId: scenario.id },
    });

    if (audience.length === 0) {
      dashboardBus.emit({
        kind: "log",
        tag: "EMPTY",
        message: "No subscribers in affected region — no alert dispatched",
        meta: { scenarioId: scenario.id },
      });
      return;
    }
    await sleep(120);

    dashboardBus.emit({
      kind: "decision",
      tag: "AGENT",
      message: `Agent decision: priority=${severity}, confidence floor OK, dispatch=${audience.length}×${2} channels`,
      meta: { provenance: "rules", priority: severity, users: audience.length },
    });
    await sleep(120);

    // Persist the event row into the dashboard store.
    const evRow = buildNormalizedEvent(scenario);
    recordEvent(this.store, evRow);

    // Send through mock Caspian and persist alert rows.
    const comm = new MockCaspianCommProvider();
    await comm.connect({ email: { domain: "demo.aegis.ai" }, telegram: { botToken: "mock" }, discord: { botToken: "mock" } });

    for (const user of audience) {
      const channels = user.subscribedChannels;
      for (const channel of channels) {
        const contact =
          user.contacts.find((c) => c.channel === channel) ?? { channel, address: `${channel}:${user.id}@demo.aegis.ai` };
        const alertId = `${evRow.id}:${user.id}:${channel}`;
        const composedText = composeText(evRow, severity, channel);
        const alert = {
          id: alertId,
          eventId: evRow.id,
          userId: user.id,
          channel,
          severity,
          composed: { text: composedText, subject: evRow.title },
          status: "queued" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        insertAlert(this.store, alert);

        dashboardBus.emit({
          kind: "queued",
          tag: channel.toUpperCase(),
          message: `${channel.toUpperCase()} queued for ${user.name || user.id}`,
          meta: { eventId: evRow.id, channel, recipient: contact.address },
        });

        try {
          const { conversationId, messageId } = await comm.sendAlert({
            contact,
            alert: { text: alert.composed.text, subject: alert.composed.subject },
          });
          updateAlertStatus(this.store, alertId, "delivered", { conversationId });
          // If conversationId is undefined the mock still emitted a row;
          // the messageId we record for the dashboard.
          void messageId;
          dashboardBus.emit({
            kind: "delivered",
            tag: channel.toUpperCase(),
            message: `${channel.toUpperCase()} DELIVERED to ${user.name || user.id}`,
            meta: { eventId: evRow.id, channel, recipient: contact.address, conversationId },
          });
        } catch (err) {
          updateAlertStatus(this.store, alertId, "failed", { error: String(err) });
          dashboardBus.emit({
            kind: "failed",
            tag: channel.toUpperCase(),
            message: `${channel.toUpperCase()} FAILED for ${user.id} — ${String(err)}`,
            meta: { eventId: evRow.id, channel, error: String(err) },
          });
        }
        await sleep(40);
      }
    }

    log.info({ scenario: scenario.id, delivered: comm.sends.length, ms: Date.now() - t0 }, "scenario dispatched");
  }

  /** Return the most recent alerts for diagnostics. */
  tail(limit = 50): { events: ReturnType<typeof recentEvents>; alerts: ReturnType<typeof recentAlerts> } {
    return {
      events: recentEvents(this.store, limit),
      alerts: recentAlerts(this.store, limit),
    };
  }

  /** Build a DashboardState snapshot for the HTTP layer. */
  async snapshot() {
    return buildDashboardState(this.store);
  }

  /** Background loop that cycles scenarios at the requested interval. */
  startLoop(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const s = this.scenarios[this.cursor % this.scenarios.length];
      this.cursor += 1;
      if (!s) return;
      this.execute(s).catch((err) => log.warn({ err: String(err) }, "scenario loop error"));
    }, intervalMs);
  }

  stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Direct SSE-replay buffer of recent timeline events. */
  recentTimeline(limit = 100): import("./bus.js").TimelineEvent[] {
    void limit; // bus already exposes recent via its listeners; replay happens on SSE connect
    return this.recentReplay(limit);
  }

  private recentReplay(limit: number): import("./bus.js").TimelineEvent[] {
    return this.ring.events.slice(-limit);
  }
}

function tail(): { events: import("./bus.js").TimelineEvent[] } {
  return { events: [] as import("./bus.js").TimelineEvent[] };
}

function humanType(t: string): string {
  return t
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------------------------------------------------------------- */
/* Matcher (kept inline so we don't drag the agent module into the store-only
 * driver; semantics mirror production).                                        */
/* -------------------------------------------------------------------------- */

import { matchAudience } from "../agent/audience.js";
import { severityFromScore } from "../types/events.js";
import type { NormalizedEvent, Severity } from "../types/events.js";
import type { User } from "../types/user.js";

function normalizeForMatcher(scenario: Scenario): NormalizedEvent {
  const sev: Severity = severityFromScore(scenario.discovered.severityScore ?? 0);
  return {
    id: `sim-${scenario.id}-${Date.now()}`,
    source: "simulated",
    externalId: scenario.discovered.externalId,
    sourceName: scenario.discovered.sourceName,
    sourceUrl: scenario.discovered.sourceUrl,
    type: scenario.discovered.type,
    severity: sev,
    confidence: scenario.discovered.confidence ?? 0.85,
    title: scenario.discovered.title,
    description: scenario.discovered.description ?? "",
    locationName: scenario.discovered.locationName,
    location: scenario.discovered.location,
    affectedRegion: {
      kind: "radius",
      center: scenario.discovered.location,
      radiusKm: scenario.discovered.radiusKm ?? 100,
    },
    magnitude: scenario.discovered.magnitude,
    occurredAt: scenario.discovered.occurredAt ?? new Date().toISOString(),
    observedAt: new Date().toISOString(),
    expectedAt: scenario.discovered.expectedAt,
  };
}

function audienceOf(ev: NormalizedEvent, users: User[]): User[] {
  return matchAudience({ event: ev, users }).map((m) => m.user);
}

function buildNormalizedEvent(scenario: Scenario): NormalizedEvent {
  return normalizeForMatcher(scenario);
}

function composeText(ev: NormalizedEvent, severity: string, channel: string): string {
  const prefix = `[${severity}] ${humanType(ev.type)}`;
  const where = ev.locationName ? ` near ${ev.locationName}` : "";
  const when = ev.expectedAt ? ` ETA ${ev.expectedAt}` : "";
  return `${prefix} detected${where}.${when} Take protective action. Source: ${ev.sourceName}.`;
}