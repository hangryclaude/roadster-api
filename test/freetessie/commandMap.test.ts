// commandMap: every one of the 21 TESSIE_COMMANDS names maps to the right Fleet call,
// unknown names are rejected, and bad numeric params are rejected before ever reaching
// the network. No test here exercises anything Autopilot/FSD/Summon/speed/drive-shaped —
// the vocabulary is closed and none of those names are in it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planCommand } from "../../src/freetessie/commandMap.ts";
import { TESSIE_COMMANDS, UnknownCommandError } from "../../src/freetessie/contracts.ts";

test("every TESSIE_COMMANDS name produces a plan (no throw) with plausible params", () => {
  const sampleQuery: Record<string, Record<string, string>> = {
    wake: {},
    start_climate: {},
    stop_climate: {},
    set_temperatures: { temperature: "20.0" },
    lock: {},
    unlock: {},
    start_charging: {},
    stop_charging: {},
    set_charge_limit: { percent: "80" },
    open_charge_port: {},
    close_charge_port: {},
    activate_rear_trunk: {},
    activate_front_trunk: {},
    honk: {},
    flash: {},
    enable_sentry: {},
    disable_sentry: {},
    vent_windows: {},
    close_windows: {},
    share: { value: "1900 Park Ave, Denver, CO" },
    schedule_departure: {
      enable: "true",
      departure_time: "120",
      preconditioning_enabled: "true",
    },
  };

  assert.equal(TESSIE_COMMANDS.length, 21);
  for (const name of TESSIE_COMMANDS) {
    assert.doesNotThrow(() => planCommand(name, sampleQuery[name]), `planCommand("${name}") threw`);
  }
});

test("wake plans to {kind: 'wake'}", () => {
  assert.deepEqual(planCommand("wake", {}), { kind: "wake" });
});

test("lock/unlock map to door_lock/door_unlock with no body", () => {
  assert.deepEqual(planCommand("lock", {}), { kind: "signed", name: "door_lock", body: undefined });
  assert.deepEqual(planCommand("unlock", {}), { kind: "signed", name: "door_unlock", body: undefined });
});

test("set_temperatures splits the single Celsius value to driver and passenger", () => {
  const plan = planCommand("set_temperatures", { temperature: "21.5" });
  assert.deepEqual(plan, {
    kind: "signed",
    name: "set_temps",
    body: { driver_temp: 21.5, passenger_temp: 21.5 },
  });
});

test("set_temperatures rejects a value outside Tessie's documented 15-28°C range", () => {
  assert.throws(() => planCommand("set_temperatures", { temperature: "40" }), /must be between 15 and 28/);
  assert.throws(() => planCommand("set_temperatures", { temperature: "5" }), /must be between 15 and 28/);
});

test("set_charge_limit passes percent through to Fleet's percent field", () => {
  const plan = planCommand("set_charge_limit", { percent: "80" });
  assert.deepEqual(plan, { kind: "signed", name: "set_charge_limit", body: { percent: 80 } });
});

test("set_charge_limit rejects a non-numeric percent", () => {
  assert.throws(() => planCommand("set_charge_limit", { percent: "not-a-number" }), /must be a number/);
});

test("set_charge_limit rejects an out-of-range percent", () => {
  assert.throws(() => planCommand("set_charge_limit", { percent: "150" }), /must be between/);
});

test("activate_rear_trunk / activate_front_trunk set which_trunk", () => {
  assert.deepEqual(planCommand("activate_rear_trunk", {}), {
    kind: "signed",
    name: "actuate_trunk",
    body: { which_trunk: "rear" },
  });
  assert.deepEqual(planCommand("activate_front_trunk", {}), {
    kind: "signed",
    name: "actuate_trunk",
    body: { which_trunk: "front" },
  });
});

test("enable_sentry / disable_sentry set the on flag", () => {
  assert.deepEqual(planCommand("enable_sentry", {}), {
    kind: "signed",
    name: "set_sentry_mode",
    body: { on: true },
  });
  assert.deepEqual(planCommand("disable_sentry", {}), {
    kind: "signed",
    name: "set_sentry_mode",
    body: { on: false },
  });
});

test("vent_windows / close_windows set command and default lat/lon to 0", () => {
  assert.deepEqual(planCommand("vent_windows", {}), {
    kind: "signed",
    name: "window_control",
    body: { command: "vent", lat: 0, lon: 0 },
  });
  assert.deepEqual(planCommand("close_windows", {}), {
    kind: "signed",
    name: "window_control",
    body: { command: "close", lat: 0, lon: 0 },
  });
});

test("share plans to a navigation command with the address", () => {
  assert.deepEqual(planCommand("share", { value: "221B Baker St" }), {
    kind: "navigation",
    address: "221B Baker St",
  });
});

test("share without a value throws", () => {
  assert.throws(() => planCommand("share", {}), /"value" is required/);
});

test("schedule_departure enable:true sends the full Fleet body with safe defaults", () => {
  const plan = planCommand("schedule_departure", {
    enable: "true",
    departure_time: "120",
    preconditioning_enabled: "true",
  });
  assert.deepEqual(plan, {
    kind: "signed",
    name: "set_scheduled_departure",
    body: {
      enable: true,
      departure_time: 120,
      preconditioning_enabled: true,
      preconditioning_weekdays_only: false,
      off_peak_charging_enabled: false,
      off_peak_charging_weekdays_only: false,
      end_off_peak_time: 0,
    },
  });
});

test("schedule_departure forwards the four off-peak/preconditioning params Tessie documents as real", () => {
  const plan = planCommand("schedule_departure", {
    enable: "true",
    departure_time: "120",
    preconditioning_enabled: "true",
    preconditioning_weekdays_only: "true",
    off_peak_charging_enabled: "true",
    off_peak_charging_weekdays_only: "true",
    end_off_peak_time: "360",
  });
  assert.deepEqual(plan, {
    kind: "signed",
    name: "set_scheduled_departure",
    body: {
      enable: true,
      departure_time: 120,
      preconditioning_enabled: true,
      preconditioning_weekdays_only: true,
      off_peak_charging_enabled: true,
      off_peak_charging_weekdays_only: true,
      end_off_peak_time: 360,
    },
  });
});

test("schedule_departure enable:false clears it with no other fields required", () => {
  const plan = planCommand("schedule_departure", { enable: "false" });
  assert.deepEqual(plan, {
    kind: "signed",
    name: "set_scheduled_departure",
    body: { enable: false },
  });
});

test("schedule_departure enable:true without departure_time throws", () => {
  assert.throws(
    () => planCommand("schedule_departure", { enable: "true" }),
    /"departure_time" must be a number/,
  );
});

test("an unknown command name throws UnknownCommandError", () => {
  assert.throws(() => planCommand("autopilot_engage", {}), UnknownCommandError);
  assert.throws(() => planCommand("summon", {}), UnknownCommandError);
  assert.throws(() => planCommand("not_a_real_command", {}), UnknownCommandError);
});
