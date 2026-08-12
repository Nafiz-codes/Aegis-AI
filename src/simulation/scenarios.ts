import type { DiscoveredEvent } from "../services/discoveredEvent.js";
import type {
  DisasterType,
  NormalizedEvent,
  SeverityLevel,
} from "../types/events.js";
import type { Contact, User } from "../types/user.js";

/**
 * One configured demo scenario. Each scenario ships with:
 *   - a discovered event as it would arrive from a provider (one source)       
 *   - a set of subscribed users spread across the affected region            
 *   - metadata for the pipeline banner                                        
 *
 * The scenarios are designed so the geo matcher exercises a different subset   
 * of users each time. Severity thresholds on each user gate the agent properly.
 */

export interface ScenarioUserSpec {
  id: string;
  name: string;
  subscribedLocations: ReadonlyArray<{
    name: string;
    lat: number;
    lon: number;
    radiusKm: number;
  }>;
  channels: ReadonlyArray<"email" | "discord" | "telegram">;
  severityThreshold?: SeverityLevel;
}

export interface Scenario {
  /** One-word tag used by the CLI (e.g. "critical", "high", "moderate", "low") */
  id: string;
  /** Display heading for the printed pipeline. */
  label: string;
  /** The event this scenario triggers. */
  discovered: DiscoveredEvent;
  /** Users available in the simulator's in-memory store. */
  users: ReadonlyArray<ScenarioUserSpec>;
}

const CONTACTS = (
  channels: ReadonlyArray<"email" | "discord" | "telegram">,
  prefix: string,
): Contact[] =>
  channels.map((channel) => {
    if (channel === "email") {
      return { channel, address: `${prefix}@demo.aegis.ai` };
    }
    if (channel === "discord") {
      return { channel, address: `discord:${prefix}` };
    }
    return { channel, address: `tg:${prefix}` };
  });

const buildUser = (s: ScenarioUserSpec): User => ({
  id: s.id,
  name: s.name,
  subscribedLocations: s.subscribedLocations.map((l) => ({
    name: l.name,
    center: { lat: l.lat, lon: l.lon },
    radiusKm: l.radiusKm,
  })),
  subscribedChannels: [...s.channels],
  contacts: CONTACTS(s.channels, s.id.toLowerCase()),
  preferences: { severityThreshold: s.severityThreshold ?? "MODERATE" },
  locale: "en",
  active: true,
});

/* -------------------------------------------------------------------------- */
/* Shared geography                                                           */
/* -------------------------------------------------------------------------- */

const DHAKA = { lat: 23.8103, lon: 90.4125 };
const CHATTOGRAM = { lat: 22.3569, lon: 91.7832 };
const KHULNA = { lat: 22.8456, lon: 89.5403 };
const BAY_OF_BENGAL = { lat: 21.5, lon: 89.5 };

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

const critical: Scenario = {
  id: "critical",
  label: "CRITICAL cyclone approaching the Bay of Bengal",
  discovered: {
    externalId: `sim-cyclone-${Date.now()}`,
    source: "simulated",
    sourceName: "Aegis Simulated Source (BMD-style)",
    sourceUrl:
      "https://sim.aegis.ai/events/bay-of-bengal-cyclone/2026-08-12/eye",
    type: "cyclone" as DisasterType,
    severityScore: 0.95,
    confidence: 0.95,
    title:
      "Category 3 cyclone, sustained winds 185 km/h, approaching Bangladesh coast",
    description:
      "Eye expected 90 km SE of Chattogram in 9 hours. Storm surge up to 3 m.",
    locationName: "Bay of Bengal (south of Chattogram)",
    location: BAY_OF_BENGAL,
    radiusKm: 350,
    magnitude: 3,
    expectedAt: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString(),
    occurredAt: new Date().toISOString(),
  },
  users: [
    {
      id: "alice",
      name: "Alice (Dhaka)",
      subscribedLocations: [{ name: "Dhaka", ...DHAKA, radiusKm: 80 }],
      channels: ["telegram", "email"],
    },
    {
      id: "bob",
      name: "Bob (Dhaka)",
      subscribedLocations: [{ name: "Dhaka", ...DHAKA, radiusKm: 80 }],
      channels: ["discord", "email"],
    },
    {
      id: "carol",
      name: "Carol (Chattogram)",
      subscribedLocations: [
        { name: "Chattogram", ...CHATTOGRAM, radiusKm: 30 },
      ],
      channels: ["email", "telegram"],
    },
    {
      id: "dan",
      name: "Dan (Khulna)",
      subscribedLocations: [{ name: "Khulna", ...KHULNA, radiusKm: 60 }],
      channels: ["discord"],
    },
    {
      id: "eve",
      name: "Eve (far away)",
      subscribedLocations: [
        { name: "Delhi", lat: 28.6139, lon: 77.209, radiusKm: 100 },
      ],
      channels: ["telegram"],
      // Eve lives outside the cyclone path and demands HIGH+ so she only
      // gets pinged when the cyclone escalates.
      severityThreshold: "HIGH",
    },
  ],
};

const high: Scenario = {
  id: "high",
  label: "HIGH severity flood in central Bangladesh",
  discovered: {
    externalId: `sim-flood-${Date.now()}`,
    source: "simulated",
    sourceName: "Aegis Simulated Source (FFWC-style)",
    sourceUrl:
      "https://sim.aegis.ai/events/bangladesh-flood/2026-08-12/khulna",
    type: "flood" as DisasterType,
    severityScore: 0.7,
    confidence: 0.85,
    title: "River water rising rapidly along the Padma",
    description:
      "Multiple districts under water. Embankments at risk. Evacuation advised.",
    locationName: "Khulna region, Bangladesh",
    location: KHULNA,
    radiusKm: 200,
    magnitude: undefined,
    expectedAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    occurredAt: new Date().toISOString(),
  },
  users: [
    {
      id: "alice",
      name: "Alice (Dhaka)",
      subscribedLocations: [{ name: "Dhaka", ...DHAKA, radiusKm: 80 }],
      channels: ["telegram", "email"],
    },
    {
      id: "bob",
      name: "Bob (Dhaka)",
      subscribedLocations: [{ name: "Dhaka", ...DHAKA, radiusKm: 80 }],
      channels: ["discord", "email"],
    },
    {
      id: "dan",
      name: "Dan (Khulna)",
      subscribedLocations: [{ name: "Khulna", ...KHULNA, radiusKm: 60 }],
      channels: ["discord"],
    },
    {
      id: "carol",
      name: "Carol (Chattogram, HIGH threshold)",
      subscribedLocations: [
        { name: "Chattogram", ...CHATTOGRAM, radiusKm: 30 },
      ],
      channels: ["email", "telegram"],
      severityThreshold: "HIGH",
    },
  ],
};

const moderate: Scenario = {
  id: "moderate",
  label: "MODERATE earthquake near Dhaka",
  discovered: {
    externalId: `sim-quake-${Date.now()}`,
    source: "simulated",
    sourceName: "Aegis Simulated Source (USGS-style)",
    sourceUrl: "https://sim.aegis.ai/events/dhaka-quake/2026-08-12",
    type: "earthquake" as DisasterType,
    severityScore: 0.5,
    confidence: 0.8,
    title: "M4.5 earthquake 30 km W of Dhaka",
    description: "Light shaking expected. No major damage forecast.",
    locationName: "Dhaka region, Bangladesh",
    location: { ...DHAKA },
    radiusKm: 80,
    magnitude: 4.5,
    occurredAt: new Date().toISOString(),
  },
  users: [
    {
      id: "alice",
      name: "Alice (Dhaka)",
      subscribedLocations: [{ name: "Dhaka", ...DHAKA, radiusKm: 80 }],
      channels: ["telegram", "email"],
    },
    {
      id: "bob",
      name: "Bob (Dhaka)",
      subscribedLocations: [{ name: "Dhaka", ...DHAKA, radiusKm: 80 }],
      channels: ["discord", "email"],
    },
    {
      id: "carol",
      name: "Carol (Chattogram)",
      subscribedLocations: [
        { name: "Chattogram", ...CHATTOGRAM, radiusKm: 30 },
      ],
      channels: ["email", "telegram"],
    },
    {
      id: "frank",
      name: "Frank (Dhaka, CRITICAL threshold)",
      subscribedLocations: [{ name: "Dhaka", ...DHAKA, radiusKm: 80 }],
      channels: ["email"],
      severityThreshold: "CRITICAL",
    },
  ],
};

const low: Scenario = {
  id: "low",
  label: "LOW severity weather advisory in Chattogram",
  discovered: {
    externalId: `sim-weather-${Date.now()}`,
    source: "simulated",
    sourceName: "Aegis Simulated Source (NWS-style)",
    sourceUrl: "https://sim.aegis.ai/events/chattogram-weather/2026-08-12",
    type: "extreme_weather" as DisasterType,
    severityScore: 0.15,
    confidence: 0.6,
    title: "Thunderstorm watch: brief heavy rain and gusty winds",
    description:
      "Localized heavy rain possible this evening. No flooding expected.",
    locationName: "Chattogram region, Bangladesh",
    location: CHATTOGRAM,
    radiusKm: 60,
    occurredAt: new Date().toISOString(),
  },
  users: [
    {
      id: "carol",
      name: "Carol (Chattogram)",
      subscribedLocations: [
        { name: "Chattogram", ...CHATTOGRAM, radiusKm: 30 },
      ],
      channels: ["email", "telegram"],
    },
    {
      id: "grace",
      name: "Grace (Chattogram, LOW threshold)",
      subscribedLocations: [
        { name: "Chattogram", ...CHATTOGRAM, radiusKm: 30 },
      ],
      channels: ["telegram"],
      severityThreshold: "LOW",
    },
    {
      id: "bob",
      name: "Bob (Dhaka)",
      subscribedLocations: [{ name: "Dhaka", ...DHAKA, radiusKm: 80 }],
      channels: ["discord", "email"],
    },
  ],
};

export const SCENARIOS: ReadonlyArray<Scenario> = [critical, high, moderate, low];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id.toLowerCase());
}

/** Convert scenario users into User records the store + matcher understand. */
export function scenarioUsers(scenario: Scenario): User[] {
  return scenario.users.map(buildUser);
}

export type { NormalizedEvent };
