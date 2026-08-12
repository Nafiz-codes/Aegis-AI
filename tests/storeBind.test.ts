import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/db.js";
import { upsertUser, getUser, getActiveUsers } from "../src/store/users.js";
import { recordEvent, recentEvents, hasEvent } from "../src/store/events.js";
import { insertAlert, recentAlerts } from "../src/store/alerts.js";
import type { NormalizedEvent, SeverityLevel } from "../src/types/events.js";

async function freshStore(): Promise<Store> {
  return Store.open(":memory:");
}

function sampleUser(id: string, overrides: Partial<{ active: boolean }> = {}) {
  return {
    id,
    name: `User ${id}`,
    locale: "en",
    active: overrides.active ?? true,
    location: { lat: 23.8, lon: 90.4 },
    radiusKm: 50,
    contacts: [{ channel: "email" as const, address: `${id}@x.test` }],
    subscribedChannels: ["email"] as Array<"email" | "telegram" | "discord">,
    preferences: {},
  };
}

function sampleEvent(id: string, level: SeverityLevel = "HIGH"): NormalizedEvent {
  return {
    id,
    source: "simulated",
    externalId: `ext-${id}`,
    sourceName: "Test Source",
    sourceUrl: "https://test",
    type: "earthquake",
    severity: { level, score: 0.8 },
    confidence: 0.9,
    title: `Test event ${id}`,
    description: "desc",
    locationName: "Test City",
    location: { lat: 23.8, lon: 90.4 },
    affectedRegion: { kind: "radius", center: { lat: 23.8, lon: 90.4 }, radiusKm: 100 },
    occurredAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
  };
}

describe("Store.all / Store.first bind regression", () => {
  let store: Store;
  beforeEach(async () => {
    store = await freshStore();
  });

  it("binds LIMIT ? in recentEvents", () => {
    recordEvent(store, sampleEvent("a"));
    recordEvent(store, sampleEvent("b"));
    recordEvent(store, sampleEvent("c"));
    const rows = recentEvents(store, 2);
    expect(rows).toHaveLength(2);
  });

  it("binds WHERE id = ? in hasEvent and getUser", () => {
    upsertUser(store, sampleUser("u-1"));
    expect(hasEvent(store, "nope")).toBe(false);
    recordEvent(store, sampleEvent("ev-1"));
    expect(hasEvent(store, "ev-1")).toBe(true);
    expect(getUser(store, "u-1")?.id).toBe("u-1");
    expect(getUser(store, "missing")).toBeNull();
  });

  it("returns active users only via getActiveUsers", () => {
    upsertUser(store, sampleUser("u-active"));
    upsertUser(store, sampleUser("u-inactive", { active: false }));
    const rows = getActiveUsers(store);
    expect(rows.map((u) => u.id)).toEqual(["u-active"]);
  });

  it("binds LIMIT ? in recentAlerts", () => {
    recordEvent(store, sampleEvent("ev"));
    insertAlert(store, {
      id: "a-1",
      eventId: "ev",
      userId: "u-1",
      channel: "email",
      severity: "HIGH",
      composed: { text: "t", subject: "s" },
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const rows = recentAlerts(store, 5);
    expect(rows).toHaveLength(1);
  });
});