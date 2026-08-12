import { pino, type Logger } from "pino";
import { loadConfig } from "./config.js";

let root: Logger | null = null;

export function getLogger(): Logger {
  if (root) return root;
  const cfg = loadConfig();
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
