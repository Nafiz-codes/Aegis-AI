import { describe, expect, it } from "vitest";
import {
  filterUsersByRegion,
  isUserInAudience,
  matchAudience,
} from "../src/agent/audience.js";
import type { LocationMatcher } from "../src/services/locationMatcher.js";
import type { NormalizedEvent } from "../src/types/events.js";
import type { User } from "../src/types/user.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const DHAKA = { lat: 23.8103, lon: 90.4125 };
const CHATTOGRAM = { lat: 22.3569, lon: 91.7832 };

const baseEvent = (
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent => ({
  id: "evt_1",
  source: "usgs",
  externalId: "usgs:1",
  sourceName: "USGS Earthquake Hazards Program",
  sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/1",
  type: "earthquake",
  severity: { level: "MODERATE", score: 0.5 },
  confidence: 0.8,
  title: "M5.0 - near Dhaka",
  description: "Light shaking expected.",
  location: DHAKA,
  occurredAt: "2025-01-01T00:00:00.000Z",
  observedAt: "2025-01-01T00:00:05.000Z",
  affectedRegion: { kind: "radius", center: DHAKA, radiusKm: 50 },
  ...overrides,
});

const contactFor = (channels: User["subscribedChannels"]): User["contacts"] =>
  channels.map((channel) => {
    if (channel === "email") {
      return { channel, address: "u@example.com" };
    }
    if (channel === "discord") {
      return { channel, address: "discord:123" };
    }
    return { channel, address: "tg:456" };
  });

const makeUser = (overrides: Partial<User> = {}): User => {
  const channels: User["subscribedChannels"] =
    overrides.subscribedChannels ?? ["email"];
  return {
    id: "u_1",
    name: "User One",
    subscribedChannels: channels,
    contacts: contactFor(channels),
    preferences: { severityThreshold: "MODERATE" },
    active: true,
    ...overrides,
  };
};

/* -------------------------------------------------------------------------- */
/* Dhaka + Telegram / Dhaka + Discord / Chattogram + Email scenario suite     */
/* -------------------------------------------------------------------------- */

describe("matchAudience — Dhaka + Telegram / Dhaka + Discord / Chattogram + Email", () => {
  const userA = makeUser({
    id: "A",
    name: "A",
    subscribedLocations: [
      { name: "Dhaka", center: DHAKA, radiusKm: 25 },
    ],
    subscribedChannels: ["telegram"],
  });
  const userB = makeUser({
    id: "B",
    name: "B",
    subscribedLocations: [
      { name: "Dhaka", center: DHAKA, radiusKm: 25 },
    ],
    subscribedChannels: ["discord"],
  });
  const userC = makeUser({
    id: "C",
    name: "C",
    subscribedLocations: [
      { name: "Chattogram", center: CHATTOGRAM, radiusKm: 25 },
    ],
    subscribedChannels: ["email"],
  });

  it("matching location: includes users whose sub center is inside the region", () => {
    const result = matchAudience({
      event: baseEvent(),
      users: [userA, userB, userC],
    });
    expect(result.map((m) => m.user.id).sort()).toEqual(["A", "B"]);
  });

  it("non-matching location: excludes users whose sub center is outside", () => {
    const result = matchAudience({
      event: baseEvent(),
      users: [userC],
    });
    expect(result).toEqual([]);
  });

  it("multiple users: keeps every Dhaka subscriber, drops Chattogram", () => {
    const result = matchAudience({
      event: baseEvent(),
      users: [userA, userB, userC],
    });
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.user.id !== "C")).toBe(true);
  });

  it("attaches the matched subscription name for logging", () => {
    const result = matchAudience({
      event: baseEvent(),
      users: [userA, userC],
    });
    const matched = result.find((m) => m.user.id === "A");
    expect(matched?.matchedSubscription).toBe("Dhaka");
    expect(matched?.distanceKm).toBeDefined();
    expect(matched!.distanceKm!).toBeLessThan(5); // sub center == event center
  });

  it("multiple channels per user: returns the user once (channels routed later)", () => {
    const multi = makeUser({
      id: "multi",
      subscribedLocations: [
        { name: "Dhaka", center: DHAKA, radiusKm: 25 },
      ],
      subscribedChannels: ["email", "discord", "telegram"],
    });
    const result = matchAudience({
      event: baseEvent(),
      users: [multi],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.user.subscribedChannels).toEqual([
      "email",
      "discord",
      "telegram",
    ]);
  });

  it("filterUsersByRegion returns just the user records", () => {
    const users = filterUsersByRegion({
      event: baseEvent(),
      users: [userA, userB, userC],
    });
    expect(users.map((u) => u.id).sort()).toEqual(["A", "B"]);
  });

  it("isUserInAudience flags membership for a single user", () => {
    expect(
      isUserInAudience({ user: userA, event: baseEvent() }),
    ).toBe(true);
    expect(
      isUserInAudience({ user: userC, event: baseEvent() }),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Severity thresholds                                                        */
/* -------------------------------------------------------------------------- */

describe("matchAudience — severity thresholds", () => {
  const strict = makeUser({
    id: "strict",
    preferences: { severityThreshold: "HIGH" },
    subscribedLocations: [{ name: "Dhaka", center: DHAKA, radiusKm: 25 }],
  });
  const anyUser = makeUser({
    id: "any",
    preferences: { severityThreshold: "MODERATE" },
    subscribedLocations: [{ name: "Dhaka", center: DHAKA, radiusKm: 25 }],
  });

  it("MODERATE user is included on a MODERATE event", () => {
    const r = matchAudience({ event: baseEvent(), users: [anyUser, strict] });
    expect(r.map((m) => m.user.id)).toEqual(["any"]);
  });

  it("HIGH user is skipped on a MODERATE event (below threshold)", () => {
    const r = matchAudience({ event: baseEvent(), users: [strict] });
    expect(r).toEqual([]);
  });

  it("HIGH user is included on a HIGH event (at threshold)", () => {
    const ev = baseEvent({ severity: { level: "HIGH", score: 0.7 } });
    const r = matchAudience({ event: ev, users: [strict, anyUser] });
    expect(r.map((m) => m.user.id).sort()).toEqual(["any", "strict"]);
  });

  it("HIGH user is included on a CRITICAL event (above threshold)", () => {
    const ev = baseEvent({ severity: { level: "CRITICAL", score: 0.95 } });
    const r = matchAudience({ event: ev, users: [strict] });
    expect(r).toHaveLength(1);
  });

  it("LOW user is included on any tier (no floor blocks LOW)", () => {
    const low = makeUser({
      id: "low",
      preferences: { severityThreshold: "LOW" },
      subscribedLocations: [{ name: "Dhaka", center: DHAKA, radiusKm: 25 }],
    });
    const ev = baseEvent({ severity: { level: "LOW", score: 0.2 } });
    const r = matchAudience({ event: ev, users: [low] });
    expect(r).toHaveLength(1);
  });

  it("CRITICAL user ignores LOW and MODERATE events", () => {
    const fussy = makeUser({
      id: "fussy",
      preferences: { severityThreshold: "CRITICAL" },
      subscribedLocations: [{ name: "Dhaka", center: DHAKA, radiusKm: 25 }],
    });
    const lowEv = baseEvent({ severity: { level: "LOW", score: 0.2 } });
    const moderateEv = baseEvent({ severity: { level: "MODERATE", score: 0.5 } });
    expect(matchAudience({ event: lowEv, users: [fussy] })).toEqual([]);
    expect(matchAudience({ event: moderateEv, users: [fussy] })).toEqual([]);
    const criticalEv = baseEvent({
      severity: { level: "CRITICAL", score: 0.95 },
    });
    expect(matchAudience({ event: criticalEv, users: [fussy] })).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Multi-subscription users                                                   */
/* -------------------------------------------------------------------------- */

describe("matchAudience — multiple subscriptions per user", () => {
  const twoCity = makeUser({
    id: "two_city",
    subscribedLocations: [
      { name: "Dhaka", center: DHAKA, radiusKm: 25 },
      { name: "Chattogram", center: CHATTOGRAM, radiusKm: 25 },
    ],
  });

  it("matches on whichever subscription the event hits", () => {
    const dhaka = matchAudience({
      event: baseEvent(),
      users: [twoCity],
    });
    expect(dhaka).toHaveLength(1);
    expect(dhaka[0]!.matchedSubscription).toBe("Dhaka");

    const ctgEvent = baseEvent({
      affectedRegion: {
        kind: "radius",
        center: CHATTOGRAM,
        radiusKm: 50,
      },
    });
    const ctg = matchAudience({
      event: ctgEvent,
      users: [twoCity],
    });
    expect(ctg).toHaveLength(1);
    expect(ctg[0]!.matchedSubscription).toBe("Chattogram");
  });

  it("does not match users whose subscriptions are all outside", () => {
    const farEvent = baseEvent({
      affectedRegion: {
        kind: "radius",
        center: { lat: 0, lon: 0 }, // Gulf of Guinea -- nowhere near our subs
        radiusKm: 10,
      },
    });
    const r = matchAudience({ event: farEvent, users: [twoCity] });
    expect(r).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Legacy `location` back-compat                                              */
/* -------------------------------------------------------------------------- */

describe("matchAudience — legacy single-point location", () => {
  it("treats a legacy `location` as a single 50km radius subscription", () => {
    const legacy = makeUser({
      id: "legacy",
      location: DHAKA,
    }) as User & { subscribedLocations?: unknown };

    // No explicit subscribedLocations -- only the legacy point.
    const r = matchAudience({ event: baseEvent(), users: [legacy] });
    expect(r).toHaveLength(1);
    expect(r[0]!.matchedSubscription).toBe("primary");
  });

  it("explicit subscribedLocations wins over legacy location if both exist", () => {
    const mixed = makeUser({
      id: "mixed",
      location: CHATTOGRAM, // 400km away from event center
      subscribedLocations: [
        { name: "Dhaka", center: DHAKA, radiusKm: 25 },
      ],
    });
    const r = matchAudience({ event: baseEvent(), users: [mixed] });
    expect(r).toHaveLength(1);
    expect(r[0]!.matchedSubscription).toBe("Dhaka");
  });

  it("a user with neither location nor subs is excluded", () => {
    const empty = {
      id: "empty",
      name: "Empty",
      subscribedChannels: ["email"],
      contacts: contactFor(["email"]),
      preferences: { severityThreshold: "MODERATE" },
      active: true,
    } as User;
    const r = matchAudience({ event: baseEvent(), users: [empty] });
    expect(r).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Region variations                                                          */
/* -------------------------------------------------------------------------- */

describe("matchAudience — region shape variations", () => {
  const dhakaOnly = makeUser({
    id: "d_only",
    subscribedLocations: [{ name: "Dhaka", center: DHAKA, radiusKm: 10 }],
  });

  it("bbox regions are honoured", () => {
    const bboxEv = baseEvent({
      affectedRegion: {
        kind: "bbox",
        bbox: {
          minLon: DHAKA.lon - 1,
          minLat: DHAKA.lat - 1,
          maxLon: DHAKA.lon + 1,
          maxLat: DHAKA.lat + 1,
        },
      },
    });
    const r = matchAudience({ event: bboxEv, users: [dhakaOnly] });
    expect(r).toHaveLength(1);
  });

  it("returns empty when the event has no affected region", () => {
    const ev = baseEvent({ affectedRegion: undefined });
    const r = matchAudience({ event: ev, users: [dhakaOnly] });
    expect(r).toEqual([]);
  });

  it("stable order: preserves the input user order for matches", () => {
    const subA = makeUser({
      id: "alpha",
      subscribedLocations: [{ name: "Dhaka", center: DHAKA, radiusKm: 25 }],
    });
    const subB = makeUser({
      id: "beta",
      subscribedLocations: [{ name: "Dhaka", center: DHAKA, radiusKm: 25 }],
    });
    const subC = makeUser({
      id: "gamma",
      subscribedLocations: [{ name: "Dhaka", center: DHAKA, radiusKm: 25 }],
    });
    const r = matchAudience({ event: baseEvent(), users: [subA, subB, subC] });
    expect(r.map((m) => m.user.id)).toEqual(["alpha", "beta", "gamma"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Custom matcher injection                                                   */
/* -------------------------------------------------------------------------- */

describe("matchAudience — pluggable matcher", () => {
  it("delegates to an injected matcher", () => {
    const user = makeUser({
      id: "x",
      subscribedLocations: [{ name: "Anywhere", center: DHAKA, radiusKm: 1 }],
    });

    const alwaysHit: LocationMatcher = {
      contains: () => ({ hit: true, distanceKm: 0 }),
    };
    const alwaysMiss: LocationMatcher = {
      contains: () => ({ hit: false }),
    };

    expect(
      matchAudience({ event: baseEvent(), users: [user], matcher: alwaysHit })
        .length,
    ).toBe(1);
    expect(
      matchAudience({ event: baseEvent(), users: [user], matcher: alwaysMiss })
        .length,
    ).toBe(0);
  });
});
