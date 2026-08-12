import "dotenv/config";
import { z } from "zod";

/**
 * Env schema. Only CASPIAN_API_KEY is strictly required for the comms layer;
 * data sources and LLM degrade gracefully when not configured.
 */
const RawEnv = z.object({
  CASPIAN_API_KEY: z.string().min(1, "CASPIAN_API_KEY is required"),
  CASPIAN_BASE_URL: z.string().url().optional(),

  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_ALERT_CHANNEL_ID: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  LLM_PROVIDER: z.enum(["template", "openai"]).default("template"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AGENT_REQUIRE_LLM: z.coerce.boolean().default(false),
  AGENT_CONFIDENCE_FLOOR: z.coerce.number().min(0).max(1).default(0),

  USGS_FEED_URL: z
    .string()
    .url()
    .default("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson"),
  NWS_API_BASE: z.string().url().default("https://api.weather.gov"),

  POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(120),
  DEDUP_WINDOW_MIN: z.coerce.number().int().positive().default(30),

  AEGIS_DB_PATH: z.string().default("./data/aegis.db"),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z.string().default("development"),
});

export type Config = z.infer<typeof RawEnv> & {
  hasDiscord: boolean;
  hasTelegram: boolean;
  hasLlm: boolean;
};

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const parsed = RawEnv.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const data = parsed.data;
  cached = {
    ...data,
    hasDiscord: Boolean(data.DISCORD_BOT_TOKEN),
    hasTelegram: Boolean(data.TELEGRAM_BOT_TOKEN),
    hasLlm: Boolean(data.OPENAI_API_KEY),
  };
  return cached;
}

/** Test helper: reset the cached config so a new env can be parsed. */
export function resetConfigCache(): void {
  cached = null;
}
