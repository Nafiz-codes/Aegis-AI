import { loadConfig } from "./config.js";
import { getLogger } from "./logger.js";
import { Store } from "./store/db.js";
import { getActiveUsers } from "./store/users.js";
import { hasEvent, recordEvent } from "./store/events.js";
import { insertAlert, updateAlertStatus } from "./store/alerts.js";
import { UsgsSource } from "./adapters/usgsSource.js";
import { NwsSource } from "./adapters/nwsSource.js";
import { CaspianCommProvider, UnverifiedCapabilityError } from "./adapters/caspianCommProvider.js";
import { TemplateLlm, type LlmProvider } from "./services/llmProvider.js";
import type { CommProvider } from "./services/commProvider.js";
import type { DisasterSource } from "./services/disasterSource.js";
import {
  affectedUsers,
  buildAlert,
  compose,
  urgency,
  verify,
} from "./agent/decide.js";

const log = getLogger();

interface AppDeps {
  store: Store;
  sources: DisasterSource[];
  comm: CommProvider;
  llm: LlmProvider;
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

  const shutdown = async () => {
    log.info("shutting down");
    await store.close();
  };

  return { deps: { store, sources, comm, llm }, shutdown };
}

/**
 * Run one poll cycle: every source fetches, we normalize, verify, dedup,
 * decide, and dispatch. Returns the number of alerts dispatched.
 */
export async function runOnce(deps: AppDeps, now: Date = new Date()): Promise<number> {
  const cfg = loadConfig();
  const cutoffMs = now.getTime() - cfg.DEDUP_WINDOW_MIN * 60 * 1000;
  let dispatched = 0;

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

      const users = affectedUsers(ev, getActiveUsers(deps.store));
      for (const user of users) {
        const { channels } = urgency(ev, user);
        for (const channel of channels) {
          const composed = await compose(ev, user, deps.llm);
          const alert = buildAlert({ event: ev, user, channel, composed });
          insertAlert(deps.store, alert);

          const contact = user.contacts.find((c) => c.channel === channel);
          if (!contact) {
            updateAlertStatus(deps.store, alert.id, "skipped", { error: "no contact" });
            continue;
          }

          try {
            const { conversationId } = await deps.comm.sendAlert({ contact, alert: composed });
            updateAlertStatus(deps.store, alert.id, "sent", { conversationId });
            dispatched += 1;
          } catch (err) {
            if (err instanceof UnverifiedCapabilityError) {
              log.warn(
                { channel, capability: err.capability },
                "unverified capability — marking alert skipped",
              );
              updateAlertStatus(deps.store, alert.id, "skipped", { error: err.message });
            } else {
              log.error({ err: String(err), channel }, "send failed");
              updateAlertStatus(deps.store, alert.id, "failed", { error: String(err) });
            }
          }
        }
      }
    }
  }

  await deps.store.flush();
  return dispatched;
}

/** Loop runOnce on a fixed interval until the signal aborts. */
export async function runScheduler(deps: AppDeps, signal: AbortSignal): Promise<void> {
  const cfg = loadConfig();
  const intervalMs = cfg.POLL_INTERVAL_SEC * 1000;
  log.info({ intervalMs }, "scheduler started");

  // Wait for first connection completion before starting inbound loop,
  // so ack handlers can rely on connected channels.
  await deps.comm.listen(signal).catch((err) => {
    log.error({ err: String(err) }, "comm listen failed");
  });
}
