import assert from "node:assert/strict";
import test from "node:test";
import { awaiting, liveCommands } from "../../src/roadster/manifest.ts";
import { commandsFor, modelFromVin, profile, profileFromVin } from "../../src/roadster/vehicles.ts";

test("modelFromVin reads the model code at position 4", () => {
  assert.equal(modelFromVin("7G2CEHED8RA000001"), "cybertruck");
  assert.equal(modelFromVin("7SAYGDEE0PF000001"), "model_y");
  assert.equal(modelFromVin("5YJ3E1EA0KF000001"), "model_3");
  assert.equal(modelFromVin("5YJSA1E26GF000001"), "model_s");
  assert.equal(modelFromVin("7SAXCBE55PF000001"), "model_x");
  assert.equal(modelFromVin("5YJRE11B081000001"), "roadster");
  assert.equal(modelFromVin("TEST000000000VIN"), "unknown");
  assert.equal(modelFromVin(""), "unknown");
  assert.equal(modelFromVin(undefined), "unknown");
  assert.equal(modelFromVin("7g2cehed8ra000001"), "cybertruck", "case-insensitive");
});

test("profiles: Cybertruck has a bed and no flight; Roadster flies (awaiting); unknown is generic", () => {
  const ct = profileFromVin("7G2CEHED8RA000001");
  assert.equal(ct.name, "Cybertruck");
  assert.equal(ct.bed, true);
  assert.equal(ct.flight, false);
  assert.equal(profile("roadster").flight, true);
  assert.equal(profile("roadster").bed, false);
  assert.equal(profile("unknown").name, "Tesla");
  assert.equal(profile("model_y").flight, false);
});

test("commandsFor: Cybertruck gets every live row and no flight rows; Roadster gets the four awaiting rows too", () => {
  const ct = commandsFor("cybertruck");
  assert.equal(ct.length, liveCommands().length);
  assert.ok(ct.every((e) => e.status === "live"));
  assert.ok(!ct.some((e) => e.name === "land"));

  const rd = commandsFor("roadster");
  assert.equal(rd.length, liveCommands().length + awaiting().length);
  assert.equal(rd.filter((e) => e.status === "awaiting_fleet_api").length, 4);

  assert.equal(commandsFor("unknown").length, liveCommands().length);
});
