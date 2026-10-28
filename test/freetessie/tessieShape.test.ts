// Round-trips toTessieState through tessieAdapter.ts's normalizeState() — proving
// freetessie's wire shape is byte-for-byte what TessieAdapter already expects, so pointing
// TESSIE_BASE_URL at freetessie needs zero changes to tessieAdapter.ts.

import assert from "node:assert/strict";
import test from "node:test";
import type { FleetVehicleData } from "../../src/freetessie/contracts.ts";
import {
  toTessieBattery,
  toTessieLocation,
  toTessieState,
} from "../../src/freetessie/tessieShape.ts";
import { normalizeState } from "../../src/tesla/tessieAdapter.ts";

const sample: FleetVehicleData = {
  vehicle_state: {
    odometer: 47382,
    locked: true,
    sentry_mode: false,
    charge_port_door_open: false,
    timestamp: 1_800_000_000_000,
  },
  charge_state: {
    battery_level: 62,
    charge_limit_soc: 90,
    charging_state: "Stopped",
    charge_energy_added: 0,
    timestamp: 1_800_000_001_000,
  },
  climate_state: {
    is_climate_on: true,
    inside_temp: 21, // Celsius
    driver_temp_setting: 22, // Celsius -> 71.6F
    timestamp: 1_800_000_002_000,
  },
  drive_state: {
    latitude: 39.7392,
    longitude: -104.9903,
    shift_state: null,
    speed: null,
    timestamp: 1_800_000_003_000,
  },
};

test("toTessieState round-trips through normalizeState with an address", () => {
  const wire = toTessieState(sample, "1900 Park Ave, Denver, CO");
  const state = normalizeState(wire);

  assert.equal(state.odometerMiles, 47382);
  assert.equal(state.batteryPercent, 62);
  assert.equal(state.chargeLimitPercent, 90);
  assert.equal(state.chargingState, "Stopped");
  assert.equal(state.locked, true);
  assert.equal(state.sentryOn, false);
  assert.equal(state.climateOn, true);
  assert.equal(state.chargePortOpen, false);
  assert.equal(state.latitude, 39.7392);
  assert.equal(state.longitude, -104.9903);
  assert.equal(state.address, "1900 Park Ave, Denver, CO");
  // 22C -> 71.6F
  assert.ok(Math.abs(state.climateTargetF! - 71.6) < 0.001);
  // The newest of the four per-category timestamps (drive_state's) wins.
  assert.equal(state.updatedAt, new Date(1_800_000_003_000).toISOString());
});

test("toTessieState with a null address maps to normalizeState's null, not a crash", () => {
  const wire = toTessieState(sample, null);
  const state = normalizeState(wire);
  assert.equal(state.address, null);
});

test("toTessieState on an empty snapshot still normalizes to the documented defaults", () => {
  const wire = toTessieState({}, null);
  const state = normalizeState(wire);
  assert.equal(state.odometerMiles, 0);
  assert.equal(state.batteryPercent, 0);
  assert.equal(state.locked, null);
  assert.equal(state.chargingState, "Disconnected");
  assert.equal(state.address, null);
});

test("toTessieBattery carries battery_level and the charge_state timestamp through", () => {
  const battery = toTessieBattery(sample);
  assert.equal(battery.battery_level, 62);
  assert.equal(battery.timestamp, 1_800_000_001_000);
});

test("toTessieLocation carries coordinates and the supplied address through", () => {
  const location = toTessieLocation(sample, "1900 Park Ave, Denver, CO");
  assert.equal(location.latitude, 39.7392);
  assert.equal(location.longitude, -104.9903);
  assert.equal(location.address, "1900 Park Ave, Denver, CO");
});

test("toTessieLocation passes a null address through unchanged", () => {
  const location = toTessieLocation(sample, null);
  assert.equal(location.address, null);
});
