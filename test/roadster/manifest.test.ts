import assert from "node:assert/strict";
import test from "node:test";
import { findTool } from "../../src/agent/tools.ts";
import { ALL_VARIANTS, MANIFEST, awaiting, findEntry, forVariant, liveCommands } from "../../src/roadster/manifest.ts";

test("every live manifest row names an agent tool that actually exists", () => {
  for (const entry of liveCommands()) {
    assert.ok(entry.tool, `${entry.name} has no tool`);
    assert.ok(findTool(entry.tool), `${entry.name} -> ${entry.tool} is not in tools.ts`);
    assert.deepEqual(entry.variants, ALL_VARIANTS, `${entry.name} should apply to every variant`);
  }
});

test("manifest names are unique and every row has an example text", () => {
  const names = MANIFEST.map((e) => e.name);
  assert.equal(new Set(names).size, names.length);
  for (const e of MANIFEST) assert.ok(e.say.length > 0, `${e.name} has no example`);
});

test("flight rows are awaiting_fleet_api, route only to roadster_flight, and have no endpoint", () => {
  const flight = awaiting();
  assert.deepEqual(
    flight.map((e) => e.name).sort(),
    ["hover", "jump", "land", "thrust_mode"],
  );
  for (const e of flight) {
    assert.equal(e.tool, "roadster_flight");
    assert.equal(e.fleetEndpoint, null);
    assert.ok(!e.variants.includes("performance"), `${e.name} must not apply to the no-thruster Performance variant`);
  }
  assert.ok(findTool("roadster_flight"), "roadster_flight tool must exist");
});

test("forVariant: performance has every live command and no flight; rocket has land", () => {
  const perf = forVariant("performance");
  assert.equal(perf.length, liveCommands().length);
  assert.ok(forVariant("rocket").some((e) => e.name === "land"));
  assert.ok(!forVariant("thrust").some((e) => e.name === "land"), "land is rocket-only");
  assert.equal(findEntry("land")?.status, "awaiting_fleet_api");
});
