import { buildApp, runOnce, runScheduler } from "./entrypoint.js";
import { getLogger } from "./logger.js";

const log = getLogger();

async function main(): Promise<void> {
  const ac = new AbortController();
  const handle = (signal: string) => {
    log.info({ signal }, "signal received");
    ac.abort();
  };
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));

  const { deps, shutdown } = await buildApp();

  try {
    // Run one poll immediately so the demo shows activity without waiting.
    const n = await runOnce(deps);
    log.info({ dispatched: n }, "initial poll complete");

    // Wire inbound handler — logs anything users send back.
    deps.comm.onMessage(async (msg) => {
      log.info({ channel: msg.channel, from: msg.from, text: msg.text }, "inbound message");
    });
    deps.comm.onInteraction(async (i) => {
      log.info({ channel: i.channel, from: i.from, value: i.value }, "inbound interaction");
    });

    // Periodic poll loop
    const cfg = await import("./config.js").then((m) => m.loadConfig());
    const intervalMs = cfg.POLL_INTERVAL_SEC * 1000;
    const pollTimer = setInterval(() => {
      runOnce(deps).catch((err) => log.error({ err: String(err) }, "poll cycle failed"));
    }, intervalMs);

    // Inbound listen loop (blocks until signal aborts).
    await runScheduler(deps, ac.signal);

    clearInterval(pollTimer);
  } finally {
    await shutdown();
  }
}

main().catch((err) => {
  log.fatal({ err: String(err) }, "fatal error");
  process.exit(1);
});
