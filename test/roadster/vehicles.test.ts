import assert from "node:assert/strict";
import test from "node:test";
import { awaiting, liveCommands } from "../../src/roadster/manifest.ts";
import { commandsFor, modelFromVin, profile, profileFromVin } from "../../src/roadster/vehicles.ts";

test("modelFromVin reads the model code at position 4", () => {
  assert.equal(modelFromVin("7SAYGDEE0PF000001"), "model_y");
  assert.equal(modelFromVin("5YJ3E1EA0KF000001"), "model_3");
  assert.equal(modelFromVin("5YJSA1E26GF000001"), "model_s");
  assert.equal(modelFromVin("7SAXCBE55PF000001"), "model_x");
  assert.equal(modelFromVin("5YJRE11B081000001"), "roadster");
  assert.equal(modelFromVin("7G2CEHED8RA000001"), "unknown", "model codes outside the list are unknown");
  assert.equal(modelFromVin("TEST000000000VIN"), "unknown");
  assert.equal(modelFromVin(""), "unknown");
  assert.equal(modelFromVin(undefined), "unknown");
  assert.equal(modelFromVin("7saygdee0pf000001"), "model_y", "case-insensitive");
});

test("profiles: Model Y has no flight; Roadster flies (awaiting); unknown is generic", () => {
  const my = profileFromVin("7SAYGDEE0PF000001");
  assert.equal(my.name, "Model Y");
  assert.equal(my.flight, false);
  assert.equal(profile("roadster").flight, true);
  assert.equal(profile("unknown").name, "Tesla");
  assert.equal(profile("model_3").flight, false);
});

test("commandsFor: Model Y gets every live row and no flight rows; Roadster gets the four awaiting rows too", () => {
  const my = commandsFor("model_y");
  assert.equal(my.length, liveCommands().length);
  assert.ok(my.every((e) => e.status === "live"));
  assert.ok(!my.some((e) => e.name === "land"));

  const rd = commandsFor("roadster");
  assert.equal(rd.length, liveCommands().length + awaiting().length);
  assert.equal(rd.filter((e) => e.status === "awaiting_fleet_api").length, 4);

  assert.equal(commandsFor("unknown").length, liveCommands().length);
});
