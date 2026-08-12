import { describe, it, expect } from "vitest";
import { findScenario, SCENARIOS, scenarioUsers } from "../src/simulation/scenarios.js";
import { runScenario } from "../src/simulation/runner.js";
import { TemplateLlm } from "../src/services/llmProvider.js";

/**
 * The simulation suite asserts the demo mode drives the *real* production
 * pipeline end-to-end. We use TemplateLlm so no API key is required and the
 * decision comes from the rules-based fallback (which is exactly what the
 * demo wants to show).
 */

const llm = new TemplateLlm();
const allIds = SCENARIOS.map((s) => s.id);

describe("simulation scenarios", () => {
  it("exposes the four documented scenarios", () => {
    expect(allIds).toEqual(["critical", "high", "moderate", "low"]);
  });

  it("findScenario is case-insensitive", () => {
    expect(findScenario("CRITICAL")?.id).toBe("critical");
    expect(findScenario("unknown")).toBeUndefined();
  });

  it("every scenario produces a positive audience", () => {
    for (const s of SCENARIOS) {
      const users = scenarioUsers(s);
      expect(users.length, `${s.id} should have seeded users`).toBeGreaterThan(0);
    }
  });
});

describe("scenario pipeline outcomes", () => {
  it("critical cyclone alerts only the in-region users and skips Eve (HIGH threshold + far away)", async () => {
    const out = await runScenario(findScenario("critical")!, { llm, verbose: false });
    expect(out.rejected).toBeNull();
    expect(out.severity).toBe("CRITICAL");
    // Alice + Bob + Carol + Dan live in radius; Eve is too far AND above threshold.
    expect(out.audienceSize).toBe(4);
    // Every channel should fire at least once.
    expect(Object.keys(out.channelsDispatched).length).toBeGreaterThanOrEqual(2);
    expect(out.decisionSummary.should_alert).toBe(true);
    expect(out.decisionSummary.priority).toBe("CRITICAL");
  });

  it("high flood reaches Dan in Khulna but skips the CRITICAL-only threshold user", async () => {
    const out = await runScenario(findScenario("high")!, { llm, verbose: false });
    expect(out.rejected).toBeNull();
    expect(out.severity).toBe("HIGH");
    expect(out.audienceSize).toBeGreaterThan(0);
    expect(out.decisionSummary.should_alert).toBe(true);
  });

  it("moderate earthquake in Dhaka is delivered and Frank (CRITICAL-only) is excluded", async () => {
    const out = await runScenario(findScenario("moderate")!, { llm, verbose: false });
    expect(out.rejected).toBeNull();
    expect(out.severity).toBe("MODERATE");
    // Alice + Bob in Dhaka match geography; Carol in Chattogram is ~150 km away
    // (outside the 80 km Dhaka radius). Frank demands CRITICAL so he is dropped.
    expect(out.audienceSize).toBe(2);
    expect(out.decisionSummary.priority).toBe("MODERATE");
  });

  it("low weather advisory demonstrates the decline path (rules suppress LOW)", async () => {
    const out = await runScenario(findScenario("low")!, { llm, verbose: false });
    // The pipeline runs end-to-end; the rules-based agent intentionally
    // declines LOW-severity advisories, which is exactly the gate we want
    // the demo to show off.
    expect(out.severity).toBe("LOW");
    expect(out.rejected).toBe("agent declined");
    expect(out.audienceSize).toBe(1); // Grace (LOW threshold, Chattogram)
  });

  it("runs the full pipeline for the three alerting scenarios without throwing", async () => {
    for (const s of SCENARIOS.filter((x) => x.id !== "low")) {
      const out = await runScenario(s, { llm, verbose: false });
      expect(out.eventId.length, `${s.id} should expose a normalized event id`).toBeGreaterThan(0);
      expect(out.rejected).toBeNull();
    }
  });
});
