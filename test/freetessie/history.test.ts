// createHistoryRecorder: feeds scripted snapshot sequences through observe() and asserts
// the resulting drives/charges/idles rows — session open/close boundaries, in-place
// updates on same-mode re-observation, and the 30-minute-gap close-at-last-known-time rule.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { FleetVehicleData } from "../../src/freetessie/contracts.ts";
import { createHistoryRecorder } from "../../src/freetessie/history.ts";

// odometer defaults to 0 for fixtures where it's irrelevant to the assertion (charging/idle
// rows don't track it) — but a real vehicle_data response always carries vehicle_state
// alongside whatever else changed, so every fixture includes it to avoid a closing
// snapshot's absent odometer silently stomping an open drive row's end_odometer back to 0.
function idle(battery: number, odometer = 0, lat = 0, lon = 0): FleetVehicleData {
  return {
    vehicle_state: { odometer },
    drive_state: { shift_state: "P", speed: 0, latitude: lat, longitude: lon },
    charge_state: { battery_level: battery, charging_state: "Disconnected" },
  };
}

function driving(odometer: number, battery: number, lat: number, lon: number): FleetVehicleData {
  return {
    vehicle_state: { odometer },
    drive_state: { shift_state: "D", speed: 10, latitude: lat, longitude: lon },
    charge_state: { battery_level: battery, charging_state: "Disconnected" },
  };
}

function charging(battery: number, energyAdded: number, lat = 0, lon = 0): FleetVehicleData {
  return {
    vehicle_state: { odometer: 0 },
    drive_state: { shift_state: "P", speed: 0, latitude: lat, longitude: lon },
    charge_state: {
      battery_level: battery,
      charging_state: "Charging",
      charge_energy_added: energyAdded,
    },
  };
}

function chargeComplete(battery: number, energyAdded: number): FleetVehicleData {
  return {
    vehicle_state: { odometer: 0 },
    drive_state: { shift_state: "P", speed: 0 },
    charge_state: {
      battery_level: battery,
      charging_state: "Complete",
      charge_energy_added: energyAdded,
    },
  };
}

test("idle -> drive (3 snapshots) -> idle produces one closed drive and two idle rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const history = createHistoryRecorder(db);

    history.observe(idle(80), 1000);
    history.observe(driving(1000.5, 79, 10.0, 20.0), 2000);
    history.observe(driving(1005, 77, 10.1, 20.1), 3000);
    history.observe(driving(1010, 75, 10.2, 20.2), 4000);
    history.observe(idle(75, 1010, 10.2, 20.2), 5000);

    const drives = history.drives();
    assert.equal(drives.length, 1);
    assert.equal(drives[0].startedAt, 2000);
    assert.equal(drives[0].endedAt, 5000);
    assert.equal(drives[0].startOdometer, 1000.5);
    assert.equal(drives[0].endOdometer, 1010);
    assert.equal(drives[0].startBattery, 79);
    assert.equal(drives[0].endBattery, 75);
    assert.equal(drives[0].startLat, 10.0);
    assert.equal(drives[0].startLon, 20.0);
    assert.equal(drives[0].endLat, 10.2);
    assert.equal(drives[0].endLon, 20.2);

    const idles = history.idles();
    assert.equal(idles.length, 2);
    assert.equal(idles[0].startedAt, 1000);
    assert.equal(idles[0].endedAt, 2000);
    assert.equal(idles[0].startBattery, 80);
    assert.equal(idles[0].endBattery, 79); // closed with the transitioning (driving) snapshot's battery
    assert.equal(idles[1].startedAt, 5000);
    assert.equal(idles[1].endedAt, null); // still open
    assert.equal(idles[1].startBattery, 75);
    assert.equal(idles[1].endBattery, 75);

    assert.equal(history.charges().length, 0);
  } finally {
    db.close();
  }
});

test("idle -> charging -> complete produces one closed charge with energyAddedKwh and two idle rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const history = createHistoryRecorder(db);

    history.observe(idle(50), 10_000);
    history.observe(charging(52, 1.2), 20_000);
    history.observe(charging(70, 8.5), 30_000);
    history.observe(chargeComplete(90, 9.8), 40_000);

    const charges = history.charges();
    assert.equal(charges.length, 1);
    assert.equal(charges[0].startedAt, 20_000);
    assert.equal(charges[0].endedAt, 40_000);
    assert.equal(charges[0].startBattery, 52);
    assert.equal(charges[0].endBattery, 90);
    assert.equal(charges[0].energyAddedKwh, 9.8);

    const idles = history.idles();
    assert.equal(idles.length, 2);
    assert.equal(idles[0].startedAt, 10_000);
    assert.equal(idles[0].endedAt, 20_000);
    assert.equal(idles[0].startBattery, 50);
    assert.equal(idles[0].endBattery, 52);
    assert.equal(idles[1].startedAt, 40_000);
    assert.equal(idles[1].endedAt, null);
    assert.equal(idles[1].startBattery, 90);
    assert.equal(idles[1].endBattery, 90);

    assert.equal(history.drives().length, 0);
  } finally {
    db.close();
  }
});

test("re-observing the same mode updates the open row in place rather than duplicating it", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const history = createHistoryRecorder(db);

    history.observe(idle(80), 1000);
    history.observe(idle(78), 2000);
    history.observe(idle(76), 3000);

    const idles = history.idles();
    assert.equal(idles.length, 1);
    assert.equal(idles[0].startedAt, 1000);
    assert.equal(idles[0].endedAt, null);
    assert.equal(idles[0].startBattery, 80);
    assert.equal(idles[0].endBattery, 76);
  } finally {
    db.close();
  }
});

test("a gap over 30 minutes closes the stale session at the last snapshot's time, not the new one", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const history = createHistoryRecorder(db);

    const t0 = 100_000;
    const gapMs = 2 * 60 * 60 * 1000 + 1; // just over 2 hours
    const t1 = t0 + gapMs;

    history.observe(idle(60), t0);
    history.observe(idle(55), t1);

    const idles = history.idles();
    assert.equal(idles.length, 2);
    // Closed AT t0 (the last snapshot we actually saw), not at t1.
    assert.equal(idles[0].startedAt, t0);
    assert.equal(idles[0].endedAt, t0);
    assert.equal(idles[0].startBattery, 60);
    assert.equal(idles[0].endBattery, 60);
    // A fresh session starts at t1, even though the mode (idle) didn't change.
    assert.equal(idles[1].startedAt, t1);
    assert.equal(idles[1].endedAt, null);
    assert.equal(idles[1].startBattery, 55);
    assert.equal(idles[1].endBattery, 55);
  } finally {
    db.close();
  }
});

test("drives/charges/idles filter by the from/to range on startedAt", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const history = createHistoryRecorder(db);

    history.observe(idle(80), 1000);
    history.observe(driving(1000, 79, 0, 0), 2000);
    history.observe(idle(75, 1000), 3000);
    history.observe(driving(1010, 70, 0, 0), 10_000);
    history.observe(idle(68, 1010), 11_000);

    const drivesInRange = history.drives(1500, 5000);
    assert.equal(drivesInRange.length, 1);
    assert.equal(drivesInRange[0].startedAt, 2000);

    const allDrives = history.drives();
    assert.equal(allDrives.length, 2);
  } finally {
    db.close();
  }
});
