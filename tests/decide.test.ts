import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  affectedUsers,
  applySeverityPolicy,
  buildAlert,
  compose,
  distanceKm,
  factBundle,
  urgency,
  verify,
} from "../src/agent/decide.js";
import type { LlmProvider } from "../src/services/llmProvider.js";
import type { NormalizedEvent } from "../src/types/events.js";
import type { User } from "../src/types/user.js";

const baseEvent = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  id: "evt_1",
  source: "usgs",
  externalId: "usgs:1",
  sourceName: "USGS Earthquake Hazards Program",
  sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/1",
  type: "earthquake",
  severity: { level: "HIGH", score: 0.7 },
  confidence: 0.85,
  title: "M5.4 - 10km S of Somewhere",
  description: "Moderate shaking expected.",
  location: { lat: 35, lon: -118 },
  occurredAt: "2025-01-01T00:00:00.000Z",
  observedAt: "2025-01-01T00:00:05.000Z",
  affectedRegion: {
    kind: "radius",
    center: { lat: 35, lon: -118 },
    radiusKm: 50,
  },
  ...overrides,
});

const user = (overrides: Partial<User> = {}): User => ({
  id: "usr_1",
  name: "Alice",
  location: { lat: 35.1, lon: -118.1 },
  subscribedChannels: ["email", "discord"],
  contacts: [{ channel: "email", address: "alice@example.com" }],
  active: true,
  ...overrides,
});

describe("distanceKm", () => {
  it("returns 0 for identical points", () => {
    expect(distanceKm({ lat: 35, lon: -118 }, { lat: 35, lon: -118 })).toBe(0);
  });

  it("agrees with a known distance roughly", () => {
    // Tokyo Station to Shinjuku Station ~ 6km
    const d = distanceKm(
      { lat: 35.681236, lon: 139.767125 },
      { lat: 35.689487, lon: 139.700641 },
    );
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThan(8);
  });
});

describe("verify", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T01:00:00.000Z"));
  });

  const ok = baseEvent();
  it.each([
    ["schema", { ...ok, severity: { level: "DEFCON", score: 0.5 } as any }],
    ["non-finite-coords", { ...ok, location: { lat: NaN, lon: 0 } as any }],
    ["occurred-in-future", { ...ok, occurredAt: "2099-01-01T00:00:00.000Z" }],
    ["occurred-too-old", { ...ok, occurredAt: "1980-01-01T00:00:00.000Z" }],
    [
      "critical-low-confidence",
      { ...ok, severity: { level: "CRITICAL", score: 0.95 }, confidence: 0.2 },
    ],
    [
      "implausible-radius",
      {
        ...ok,
        affectedRegion: {
          kind: "radius",
          center: { lat: 0, lon: 0 },
          radiusKm: 99_999,
        },
      },
    ],
    [
      "invalid-source-url",
      { ...ok, sourceUrl: "ftp://nope" },
    ],
  ])("rejects with %s", (_label, bad) => {
    const r = verify(bad as NormalizedEvent);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toBe(_label);
  });

  it("accepts a well-formed event", () => {
    expect(verify(ok).ok).toBe(true);
  });

  it("accepts event with valid bbox", () => {
    const ev = baseEvent({
      affectedRegion: {
        kind: "bbox",
        bbox: { minLon: -119, minLat: 34, maxLon: -117, maxLat: 36 },
      },
    });
    expect(verify(ev).ok).toBe(true);
  });
});

describe("applySeverityPolicy", () => {
  const base = { level: "MODERATE" as const, score: 0.5 };
  it("applies floor", () => {
    const r = applySeverityPolicy(base, "earthquake", 0.9, { floor: "HIGH" });
    expect(r.level).toBe("HIGH");
  });
  it("downgrades on low confidence", () => {
    const r = applySeverityPolicy(base, "earthquake", 0.2, {
      lowConfidenceFloor: 0.5,
    });
    expect(r.level).toBe("LOW");
  });
  it("upgrades configured types", () => {
    const r = applySeverityPolicy(base, "earthquake", 0.9, {
      upgradeTypes: ["earthquake"],
    });
    expect(r.level).toBe("HIGH");
  });
  it("clamps at CRITICAL", () => {
    const r = applySeverityPolicy(
      { level: "CRITICAL", score: 0.99 },
      "earthquake",
      0.9,
      { upgradeTypes: ["earthquake"] },
    );
    expect(r.level).toBe("CRITICAL");
  });
});

describe("affectedUsers", () => {
  const ev = baseEvent();
  const inside = user({ id: "u_inside", location: { lat: 35, lon: -118 } });
  const outside = user({ id: "u_out", location: { lat: 40, lon: -118 } });

  it("returns only users inside the region", () => {
    const result = affectedUsers(ev, [inside, outside]);
    expect(result.map((u) => u.id)).toEqual(["u_inside"]);
  });

  it("returns [] when no region is supplied", () => {
    const fallback = baseEvent({ affectedRegion: undefined });
    const result = affectedUsers(fallback, [inside, outside]);
    expect(result).toEqual([]);
  });

  it("supports bbox regions", () => {
    const bboxEv = baseEvent({
      affectedRegion: {
        kind: "bbox",
        bbox: { minLon: -120, minLat: 34, maxLon: -117, maxLat: 36 },
      },
    });
    const result = affectedUsers(bboxEv, [inside, outside]);
    expect(result.map((u) => u.id)).toEqual(["u_inside"]);
  });

  it("respects confidenceFloor", () => {
    const lowConf = baseEvent({ confidence: 0.1 });
    const result = affectedUsers(lowConf, [inside], { confidenceFloor: 0.5 });
    expect(result).toEqual([]);
  });
});

describe("urgency", () => {
  const u = user();
  it("returns all subscribed channels for CRITICAL", () => {
    const r = urgency(baseEvent({ severity: { level: "CRITICAL", score: 0.95 } }), u);
    expect(r.tone).toBe("critical");
    expect(r.channels).toEqual(["email", "discord"]);
  });
  it("returns advisory subset for MODERATE", () => {
    const r = urgency(baseEvent({ severity: { level: "MODERATE", score: 0.5 } }), u);
    expect(r.tone).toBe("advisory");
    expect(r.channels).toEqual(["email"]);
  });
  it("returns single channel for LOW", () => {
    const r = urgency(baseEvent({ severity: { level: "LOW", score: 0.2 } }), u);
    expect(r.tone).toBe("info");
    expect(r.channels).toEqual(["email"]);
  });
});

describe("factBundle", () => {
  it("excludes raw coordinates", () => {
    const b = factBundle(baseEvent());
    expect((b as any).location).toBeUndefined();
    expect(b.locationName).toBeUndefined();
  });
  it("includes magnitude and expectedAt when present", () => {
    const b = factBundle(
      baseEvent({ magnitude: 5.4, expectedAt: "2025-01-01T12:00:00.000Z" }),
    );
    expect(b.magnitude).toBe(5.4);
    expect(b.expectedAt).toBe("2025-01-01T12:00:00.000Z");
  });
});

const llmProvider = (text: string, enabled = true): LlmProvider => ({
  enabled,
  complete: async () => text,
});

describe("compose (LLM guardrail)", () => {
  const ev = baseEvent({
    locationName: "Tokio, JP",
    magnitude: 5.4,
    type: "earthquake",
    severity: { level: "HIGH", score: 0.7 },
  });
  const u = user();

  it("returns deterministic template when LLM is disabled", async () => {
    const c = await compose(ev, u, llmProvider("", false));
    expect(c.text).toContain("USGS Earthquake Hazards Program");
    expect(c.text).toContain("Tokio, JP");
  });

  it("uses LLM text when it contains all required fact tokens", async () => {
    const safe =
      "USGS Earthquake Hazards Program reports a HIGH severity earthquake near Tokio, JP. Magnitude 5.4. Stay safe.";
    const c = await compose(ev, u, llmProvider(safe));
    expect(c.text).toBe(safe);
  });

  it("falls back to template when LLM drops required tokens", async () => {
    const bad = "Heads up, something happened near you."; // no source / type / level tokens
    const c = await compose(ev, u, llmProvider(bad));
    expect(c.text).not.toBe(bad);
    expect(c.text).toContain("USGS Earthquake Hazards Program");
  });

  it("falls back to template when LLM throws", async () => {
    const broken: LlmProvider = {
      enabled: true,
      complete: async () => {
        throw new Error("rate limit");
      },
    };
    const c = await compose(ev, u, broken);
    expect(c.text).toContain("USGS Earthquake Hazards Program");
  });
});

describe("buildAlert", () => {
  it("creates a queued alert with the right severity tier", async () => {
    const ev = baseEvent();
    const u = user();
    const c = await compose(ev, u, llmProvider("", false));
    const alert = buildAlert({ event: ev, user: u, channel: "email", composed: c });
    expect(alert.severity).toBe("HIGH");
    expect(alert.status).toBe("queued");
    expect(alert.eventId).toBe(ev.id);
    expect(alert.userId).toBe(u.id);
    expect(alert.channel).toBe("email");
    expect(alert.id.length).toBeGreaterThan(0);
  });
});
