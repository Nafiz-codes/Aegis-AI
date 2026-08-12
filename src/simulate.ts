/**
 * CLI entrypoint for the hackathon demo. Runs one (or all) simulated scenarios
 * through the **real** production pipeline:
 *
 *   Simulation \u2192 ingestion (DisasterSource) \u2192 normalize() \u2192 verify() \u2192
 *   matchAudience() \u2192 AiAgent.decide() \u2192 buildRoutingIntent() \u2192 CommRouter.route()
 *   \u2192 MockCaspian (records, does not hit the network)
 *
 * Usage:
 *   npm run demo -- critical          # single scenario
 *   npm run demo -- high
 *   npm run demo -- moderate
 *   npm run demo -- low
 *   npm run demo -- all               # run all four
 *   npm run demo                      # same as "all"
 */

import { runScenario, type RunnerOutcome } from "./simulation/runner.js";
import { SCENARIOS, findScenario } from "./simulation/scenarios.js";
import { TemplateLlm } from "./services/llmProvider.js";

function usage(): void {
  process.stdout.write(
    [
      "",
      "Aegis AI \u2014 demo / simulation mode",
      "",
      "Usage:",
      "  npm run demo -- critical   # CRITICAL cyclone, Bay of Bengal",
      "  npm run demo -- high       # HIGH flood, central Bangladesh",
      "  npm run demo -- moderate   # MODERATE earthquake near Dhaka",
      "  npm run demo -- low        # LOW weather advisory, Chattogram",
      "  npm run demo -- all        # all four scenarios",
      "",
      "Each scenario runs through the EXACT same pipeline as production:",
      "  ingestion \u2192 normalize \u2192 verify \u2192 matchAudience \u2192 agent \u2192 router",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? "all").toLowerCase();
  if (arg === "--help" || arg === "-h") {
    usage();
    return;
  }

  const llm = new TemplateLlm();
  const targets =
    arg === "all" ? SCENARIOS : [findScenario(arg)].filter(Boolean);

  if (targets.length === 0) {
    usage();
    process.stderr.write(`\nUnknown scenario: "${arg}"\n`);
    process.exit(2);
  }

  const outcomes: RunnerOutcome[] = [];
  for (const s of targets) {
    const o = await runScenario(s as NonNullable<typeof targets[number]>, { llm });
    outcomes.push(o);
  }

  process.stdout.write("\n=== SUMMARY ===\n");
  for (const o of outcomes) {
    const channels = Object.entries(o.channelsDispatched)
      .map(([ch, n]) => `${ch}:${n}`)
      .join(" ");
    process.stdout.write(
      `  ${o.scenarioId.padEnd(10)} severity=${o.severity.padEnd(8)} ` +
        `users=${o.audienceSize.toString().padStart(2)} channels=${channels}\n`,
    );
  }
  process.stdout.write("\n");
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${String(err)}\n`);
  process.exit(1);
});
