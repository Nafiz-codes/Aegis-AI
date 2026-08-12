import { pino, type Logger } from "pino";
import { loadConfig } from "./config.js";

let root: Logger | null = null;
let loggedFailover = false;

/** Minimal fallback used when env config is unavailable (e.g. unit tests). */
function fallback(): Logger {
  if (!loggedFailover) {
    // eslint-disable-next-line no-console
    console.debug("[aegis] logger using fallback (no env config)");
    loggedFailover = true;
  }
  return pino({ level: "silent", base: { app: "aegis-ai" } });
}

export function getLogger(): Logger {
  if (root) return root;
  let cfg: ReturnType<typeof loadConfig> | null = null;
  try {
    cfg = loadConfig();
  } catch {
    root = fallback();
    return root;
  }
  root = pino({
    level: cfg.LOG_LEVEL,
    base: { app: "aegis-ai" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return root;
}

/** Create a child logger with a fixed module/component name. */
export function childLogger(component: string): Logger {
  return getLogger().child({ component });
}
