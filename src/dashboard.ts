import { Store } from "./store/db.js";
import { SCENARIOS } from "./simulation/scenarios.js";
import { DashboardDriver } from "./dashboard/driver.js";
import { startHttpServer } from "./dashboard/server.js";
import { dashboardBus } from "./dashboard/bus.js";
import { getLogger } from "./logger.js";

const log = getLogger();

process.on("uncaughtException", (err) => {
  log.error({ err: String(err), stack: (err as Error)?.stack }, "uncaughtException");
});
process.on("unhandledRejection", (err) => {
  log.error({ err: String(err) }, "unhandledRejection");
});

/**
 * Entry point for the hackathon dashboard. Boots an in-memory store, seeds
 * subscribers, exposes /api/state + /api/timeline (SSE), and starts a loop
 * that runs the same scenarios the demo CLI uses — so the UI is observing
 * real backend state with no fake dashboard data.
 */
async function main(): Promise<void> {
  const port = Number(process.env["AEGIS_DASHBOARD_PORT"] ?? 4310);
  const intervalSec = Number(process.env["AEGIS_DASHBOARD_INTERVAL_SEC"] ?? 12);

  log.info({ port, intervalSec }, "booting dashboard");
  const store = await Store.open(":memory:");
  const driver = new DashboardDriver({ store, scenarios: SCENARIOS });
  await driver.seedUsers();

  // Replay buffer: keep the last N timeline events so a new browser tab
  // gets instant context rather than staring at an empty log.
  const replayBuffer: import("./dashboard/bus.js").TimelineEvent[] = [];
  const cap = 200;
  dashboardBus.on((ev) => {
    replayBuffer.push(ev);
    if (replayBuffer.length > cap) replayBuffer.splice(0, replayBuffer.length - cap);
  });

  dashboardBus.emit({
    kind: "system",
    tag: "BOOT",
    message: "Aegis-AI emergency operations centre online",
  });

  const http = await startHttpServer({
    port,
    getState: () => driver.snapshot(),
    replay: () => replayBuffer.slice(),
  });
  log.info({ port }, "dashboard ready");

  // Kick off the first scenario right away so the UI isn't blank.
  void driver.execute(SCENARIOS[0]!).catch((err) =>
    log.warn({ err: String(err) }, "boot scenario failed"),
  );

  // Periodic scenario dispatch — defaults to every 12 s.
  driver.startLoop(intervalSec * 1000);

  // Graceful shutdown on SIGINT / SIGTERM.
  const stop = async () => {
    log.info("dashboard shutting down");
    driver.stopLoop();
    await http.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((err) => {
  log.error({ err: String(err) }, "dashboard crashed");
  process.exit(1);
});