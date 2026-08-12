import { describe, expect, it, beforeEach } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
  CASPIAN_API_KEY: "test-key",
};

describe("loadConfig", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it("accepts minimal env with CASPIAN_API_KEY", () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.CASPIAN_API_KEY).toBe("test-key");
    expect(cfg.hasDiscord).toBe(false);
    expect(cfg.hasTelegram).toBe(false);
    expect(cfg.hasLlm).toBe(false);
    expect(cfg.POLL_INTERVAL_SEC).toBe(120);
    expect(cfg.DEDUP_WINDOW_MIN).toBe(30);
  });

  it("derives feature flags from optional env vars", () => {
    const cfg = loadConfig({
      ...baseEnv,
      DISCORD_BOT_TOKEN: "discord-token",
      TELEGRAM_BOT_TOKEN: "telegram-token",
      OPENAI_API_KEY: "openai-key",
    });
    expect(cfg.hasDiscord).toBe(true);
    expect(cfg.hasTelegram).toBe(true);
    expect(cfg.hasLlm).toBe(true);
  });

  it("throws when CASPIAN_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrowError(/CASPIAN_API_KEY/);
  });

  it("coerces numeric env vars", () => {
    const cfg = loadConfig({
      ...baseEnv,
      POLL_INTERVAL_SEC: "60",
      DEDUP_WINDOW_MIN: "10",
    });
    expect(cfg.POLL_INTERVAL_SEC).toBe(60);
    expect(cfg.DEDUP_WINDOW_MIN).toBe(10);
  });

  it("rejects invalid LOG_LEVEL", () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: "loud" })).toThrow();
  });
});