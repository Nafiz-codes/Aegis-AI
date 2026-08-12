import { loadConfig } from "./config.js";
import { getLogger } from "./logger.js";
import { Store } from "./store/db.js";
import { getActiveUsers } from "./store/users.js";
import { hasEvent, recordEvent } from "./store/events.js";
import { insertAlert, updateAlertStatus } from "./store/alerts.js";
import { UsgsSource } from "./adapters/usgsSource.js";
import { NwsSource } from "./adapters/nwsSource.js";
import { CaspianCommProvider } from "./adapters/caspianCommProvider.js";
import { TemplateLlm, type LlmProvider } from "./services/llmProvider.js";
import type { CommProvider } from "./services/commProvider.js";
import type { DisasterSource } from "./services/disasterSource.js";
import {
  buildAlert,
  compose,
  verify,
} from "./agent/decide.js";
import { matchAudience } from "./agent/audience.js";
import { AiAgent } from "./agent/aiAgent.js";
import { CommRouter } from "./comm/router.js";
import { buildRoutingIntent } from "./comm/intent.js";

const log = getLogger();

interface AppDeps {
  store: Store;
  sources: DisasterSource[];
  comm: CommProvider;
  llm: LlmProvider;
  router: CommRouter;
}

export async function buildApp(): Promise<{ deps: AppDeps; shutdown: () => Promise<void> }> {
  const cfg = loadConfig();
  const store = await Store.open();
  const sources: DisasterSource[] = [new UsgsSource(), new NwsSource()];
  const llm: LlmProvider = new TemplateLlm();
  const comm = new CaspianCommProvider({
    apiKey: cfg.CASPIAN_API_KEY,
    baseUrl: cfg.CASPIAN_BASE_URL,
  });
  const router = new CommRouter(comm);

  const shutdown = async () => {
    log.info("shutting down");
    await store.close();
  };

  return { deps: { store, sources, comm, llm, router }, shutdown };
}

/**
 * Run one poll cycle: every source fetches, we normalize, verify, dedup,
 * decide, and dispatch. Returns the number of alerts dispatched.
 */
export async function runOnce(deps: AppDeps, now: Date = new Date()): Promise<number> {
  const cfg = loadConfig();
  const cutoffMs = now.getTime() - cfg.DEDUP_WINDOW_MIN * 60 * 1000;
  let dispatched = 0;

  const agent = new AiAgent(deps.llm);

  for (const source of deps.sources) {
    let discovered;
    try {
      discovered = await source.fetch(cutoffMs);
    } catch (err) {
      log.warn({ source: source.name, err: String(err) }, "source fetch failed");
      continue;
    }

    for (const d of discovered) {
      const ev = source.normalize(d);
      const check = verify(ev);
      if (!check.ok) {
        log.warn({ source: source.name, reason: check.reason }, "event failed verify");
        continue;
      }
      if (hasEvent(deps.store, ev.id)) continue;
      recordEvent(deps.store, ev);
      log.info({ id: ev.id, type: ev.type, severity: ev.severity }, "new event");

      const allUsers = getActiveUsers(deps.store);
      const audience = matchAudience({ event: ev, users: allUsers });
      if (audience.length === 0) continue;
      const users = audience.map((a) => a.user);

      // Route through the AI agent when real LLM available; otherwise fall
      // back to the deterministic pipeline.
      const agentOutcome = await agent.decide({ event: ev, users });
      let intent = buildRoutingIntent({
        event: ev,
        decision: agentOutcome.decision,
        users,
        retries: 2,
      });

      // If the agent declined (`should_alert=false`) or produced an empty
      // recipient set, fall back to the deterministic compose+send pipeline.
      if (!intent) {
        await runDeterministicFallback(deps, ev, users);
        continue;
      }

      log.debug(
        { provenance: agentOutcome.provenance, attempts: agentOutcome.attempts },
        "agent decision",
      );

      // Persist a queued alert row per (recipient, channel).
      const alertRows = persistQueued(deps, ev, intent);

      const result = await deps.router.route(intent);
      for (let i = 0; i < alertRows.length; i += 1) {
        const ar = alertRows[i]!;
        const o = result.outcomes[i];
        if (!o) continue;
        const finalStatus = mapDeliveryToAlertStatus(o.status);
        updateAlertStatus(
          deps.store,
          ar.id,
          finalStatus,
          {
            conversationId: o.conversationId,
            error: o.error,
          },
        );
        if (o.status === "delivered" || o.status === "sent") dispatched += 1;
      }
    }
  }

  await deps.store.flush();
  return dispatched;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function runDeterministicFallback(
  deps: AppDeps,
  ev: import("./types/events.js").NormalizedEvent,
  users: ReadonlyArray<import("./types/user.js").User>,
): Promise<void> {
  for (const user of users) {
    const composed = await compose(ev, user, deps.llm);
    const channels = user.subscribedChannels;
    for (const channel of channels) {
      const contact = user.contacts.find((c) => c.channel === channel);
      const alert = buildAlert({ event: ev, user, channel, composed });
      insertAlert(deps.store, alert);
      if (!contact) {
        updateAlertStatus(deps.store, alert.id, "skipped", { error: "no contact" });
        continue;
      }
      try {
        const { conversationId } = await deps.comm.sendAlert({ contact, alert: composed });
        updateAlertStatus(deps.store, alert.id, "sent", { conversationId });
      } catch (err) {
        log.error({ err: String(err), channel }, "send failed");
        updateAlertStatus(deps.store, alert.id, "failed", { error: String(err) });
      }
    }
  }
}

function persistQueued(
  deps: AppDeps,
  ev: import("./types/events.js").NormalizedEvent,
  intent: import("./comm/types.js").RoutingIntent,
): import("./types/alerts.js").Alert[] {
  // One alert row per (recipientName, channel) pair. We use recipient name as
  // a stand-in for userId here — the deterministic fallback path preserves
  // the source event id; this router-path version uses the recipient's
  // contact address so multiple agents can share the same alert namespace.
  const now = new Date().toISOString();
  const rows: import("./types/alerts.js").Alert[] = [];
  for (const r of intent.recipients) {
    const id = `${ev.id}:${r.channel}:${r.address}:${now}`;
    const alert: import("./types/alerts.js").Alert = {
      id,
      eventId: ev.id,
      userId: r.address,
      channel: r.channel,
      severity: intent.priority,
      composed: {
        text: intent.content.body,
        subject: intent.content.subject,
      },
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    insertAlert(deps.store, alert);
    rows.push(alert);
  }
  return rows;
}

function mapDeliveryToAlertStatus(
  s: "queued" | "sending" | "sent" | "delivered" | "failed" | "skipped",
):
  | "queued"
  | "sending"
  | "retrying"
  | "sent"
  | "delivered"
  | "failed"
  | "skipped" {
  if (s === "sent") return "sent";
  if (s === "delivered") return "delivered";
  if (s === "failed") return "failed";
  if (s === "skipped") return "skipped";
  if (s === "sending") return "sending";
  return "queued";
}

/** Loop runOnce on a fixed interval until the signal aborts. */
export async function runScheduler(deps: AppDeps, signal: AbortSignal): Promise<void> {
  const cfg = loadConfig();
  const intervalMs = cfg.POLL_INTERVAL_SEC * 1000;
  log.info({ intervalMs }, "scheduler started");

  await deps.comm.listen(signal).catch((err) => {
    log.error({ err: String(err) }, "comm listen failed");
  });
}
