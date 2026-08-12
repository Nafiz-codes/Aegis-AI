import { describe, expect, it } from "vitest";
import { NormalizedEvent } from "../src/types/events.js";
import { User } from "../src/types/user.js";
import { Alert } from "../src/types/alerts.js";

describe("NormalizedEvent schema", () => {
  const valid = {
    id: "evt_abc123",
    source: "usgs",
    externalId: "usgs:abc123",
    sourceName: "USGS Earthquake Hazards Program",
    sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/abc123",
    type: "earthquake",
    severity: { level: "HIGH", score: 0.65 },
    confidence: 0.8,
    title: "M5.4 - 10km S of Anywhere",
    description: "Minor shaking expected.",
    location: { lat: 35.0, lon: -118.0 },
    occurredAt: "2025-01-01T00:00:00.000Z",
    observedAt: "2025-01-01T00:00:05.000Z",
  };

  it("accepts a minimal valid event", () => {
    const r = NormalizedEvent.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it("rejects unknown disaster type", () => {
    const r = NormalizedEvent.safeParse({ ...valid, type: "meteor-strike" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown severity level", () => {
    const r = NormalizedEvent.safeParse({
      ...valid,
      severity: { level: "DEFCON-2", score: 0.5 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range severity score", () => {
    const r = NormalizedEvent.safeParse({
      ...valid,
      severity: { level: "HIGH", score: 2.5 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range latitude", () => {
    const r = NormalizedEvent.safeParse({
      ...valid,
      location: { lat: 95, lon: 0 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range confidence", () => {
    const r = NormalizedEvent.safeParse({ ...valid, confidence: 1.5 });
    expect(r.success).toBe(false);
  });

  it("rejects missing required externalId", () => {
    const { externalId: _drop, ...without } = valid;
    const r = NormalizedEvent.safeParse(without);
    expect(r.success).toBe(false);
  });

  it("accepts an event with an affected region (radius)", () => {
    const r = NormalizedEvent.safeParse({
      ...valid,
      affectedRegion: { kind: "radius", center: { lat: 35, lon: -118 }, radiusKm: 100 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts an event with an affected region (bbox)", () => {
    const r = NormalizedEvent.safeParse({
      ...valid,
      affectedRegion: {
        kind: "bbox",
        bbox: { minLon: -119, minLat: 34, maxLon: -117, maxLat: 36 },
      },
    });
    expect(r.success).toBe(true);
  });
});

describe("User schema", () => {
  const valid = {
    id: "usr_1",
    name: "Alice",
    location: { lat: 35.0, lon: -118.0 },
    subscribedChannels: ["email", "discord"],
    contacts: [{ channel: "email", address: "alice@example.com" }],
    active: true,
  };

  it("accepts a valid user", () => {
    const r = User.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it("rejects unknown channel", () => {
    const r = User.safeParse({
      ...valid,
      subscribedChannels: ["smoke-signal"],
    });
    expect(r.success).toBe(false);
  });
});

describe("Alert schema", () => {
  const valid = {
    id: "alrt_1",
    eventId: "evt_abc123",
    userId: "usr_1",
    channel: "email",
    severity: "HIGH",
    composed: {
      subject: "Alert",
      text: "Body",
    },
    status: "queued",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };

  it("accepts a valid alert", () => {
    const r = Alert.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it("rejects unknown status", () => {
    const r = Alert.safeParse({ ...valid, status: "flying" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown severity tier", () => {
    const r = Alert.safeParse({ ...valid, severity: "URGENT" });
    expect(r.success).toBe(false);
  });
});