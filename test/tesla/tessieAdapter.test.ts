// TessieAdapter against FakeTessieServer, every method.
//
// No test here exercises, stubs, or asserts anything Autopilot/FSD/Summon/speed/drive —
// there is no such method on VehicleAdapter to test. See SPEC.md "What this will never do."

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeTessieServer, type FakeTessieServer } from "../../src/tesla/fakeTessieServer.ts";
import { TessieAdapter, normalizeState } from "../../src/tesla/tessieAdapter.ts";

const VIN = "TEST000000000VIN";

async function withFake(
  run: (adapter: TessieAdapter, fake: FakeTessieServer) => Promise<void>,
): Promise<void> {
  const fake = createFakeTessieServer(VIN);
  const { url } = await fake.start();
  try {
    const adapter = new TessieAdapter("test-token", VIN, url);
    await run(adapter, fake);
  } finally {
    await fake.stop();
  }
}

test("getState maps the fake server's default state", async () => {
  await withFake(async (adapter) => {
    const state = await adapter.getState();
    assert.equal(state.odometerMiles, 47382);
    assert.equal(state.batteryPercent, 54);
    assert.equal(state.chargeLimitPercent, 90);
    assert.equal(state.chargingState, "Stopped");
    assert.equal(state.locked, true);
    assert.equal(state.sentryOn, false);
    assert.equal(state.climateOn, false);
    assert.equal(state.latitude, 39.7392);
    assert.equal(state.longitude, -104.9903);
    assert.equal(state.address, "1900 Park Ave, Denver, CO");
    assert.ok(!Number.isNaN(Date.parse(state.updatedAt)));
  });
});

test("wake hits the wake route without throwing", async () => {
  await withFake(async (adapter) => {
    await adapter.wake();
  });
});

test("lock/unlock flip state and the re-read reflects it", async () => {
  await withFake(async (adapter, fake) => {
    await adapter.unlock();
    assert.equal((await adapter.getState()).locked, false);
    assert.ok(fake.commandsReceived.includes("unlock"));

    await adapter.lock();
    assert.equal((await adapter.getState()).locked, true);
    assert.ok(fake.commandsReceived.includes("lock"));
  });
});

test("climateOn/climateOff flip climateOn", async () => {
  await withFake(async (adapter) => {
    await adapter.climateOn();
    assert.equal((await adapter.getState()).climateOn, true);
    await adapter.climateOff();
    assert.equal((await adapter.getState()).climateOn, false);
  });
});

test("setClimateTemp converts Fahrenheit to Celsius for the wire call", async () => {
  await withFake(async (adapter, fake) => {
    await adapter.setClimateTemp(68); // 68F = 20C
    assert.equal((await adapter.getState()).insideTempF, 68);
    assert.ok(fake.commandsReceived.includes("set_temperatures"));
  });
});

test("chargeStart/chargeStop flip chargingState", async () => {
  await withFake(async (adapter) => {
    await adapter.chargeStart();
    assert.equal((await adapter.getState()).chargingState, "Charging");
    await adapter.chargeStop();
    assert.equal((await adapter.getState()).chargingState, "Stopped");
  });
});

test("setChargeLimit sets chargeLimitPercent", async () => {
  await withFake(async (adapter) => {
    await adapter.setChargeLimit(80);
    assert.equal((await adapter.getState()).chargeLimitPercent, 80);
  });
});

test("openChargePort/closeChargePort hit their routes", async () => {
  await withFake(async (adapter, fake) => {
    await adapter.openChargePort();
    assert.ok(fake.commandsReceived.includes("open_charge_port"));
    await adapter.closeChargePort();
    assert.ok(fake.commandsReceived.includes("close_charge_port"));
  });
});

test("openTrunk/openFrunk hit Tessie's documented activate_* routes", async () => {
  await withFake(async (adapter, fake) => {
    await adapter.openTrunk();
    assert.ok(fake.commandsReceived.includes("activate_rear_trunk"));
    await adapter.openFrunk();
    assert.ok(fake.commandsReceived.includes("activate_front_trunk"));
  });
});

test("honkHorn/flashLights hit their routes", async () => {
  await withFake(async (adapter, fake) => {
    await adapter.honkHorn();
    assert.ok(fake.commandsReceived.includes("honk"));
    await adapter.flashLights();
    assert.ok(fake.commandsReceived.includes("flash"));
  });
});

test("sentryOn/sentryOff flip sentryOn", async () => {
  await withFake(async (adapter) => {
    await adapter.sentryOn();
    assert.equal((await adapter.getState()).sentryOn, true);
    await adapter.sentryOff();
    assert.equal((await adapter.getState()).sentryOn, false);
  });
});

test("ventWindows/closeWindows hit their routes", async () => {
  await withFake(async (adapter, fake) => {
    await adapter.ventWindows();
    assert.ok(fake.commandsReceived.includes("vent_windows"));
    await adapter.closeWindows();
    assert.ok(fake.commandsReceived.includes("close_windows"));
  });
});

test("navSendDestination posts to command/share with value=address", async () => {
  await withFake(async (adapter, fake) => {
    await adapter.navSendDestination("Denver International Airport");
    assert.ok(
      fake.commandsReceived.includes("share:Denver International Airport"),
      `got: ${fake.commandsReceived.join(", ")}`,
    );
  });
});

test("setScheduledDeparture hits its route", async () => {
  await withFake(async (adapter, fake) => {
    await adapter.setScheduledDeparture("2026-10-27T08:00:00-06:00", true);
    assert.ok(fake.commandsReceived.includes("schedule_departure"));
  });
});

test("a command returning HTTP 200 with result:false throws, not silently succeeds", async () => {
  await withFake(async (adapter, fake) => {
    fake.failNextCommand = "honk";
    await assert.rejects(() => adapter.honkHorn(), /result:false/);
  });
});

test("getState's realtime option bypasses the cache query flag without erroring", async () => {
  await withFake(async (adapter) => {
    const state = await adapter.getState({ realtime: true });
    assert.equal(state.locked, true);
  });
});

test("a non-ok response from the fake server throws, not silently fails", async () => {
  const fake = createFakeTessieServer(VIN);
  const { url } = await fake.start();
  try {
    // Deliberately wrong VIN so every route 404s, to prove request() surfaces failures
    // rather than swallowing them (no defensive try/catch around a call that shouldn't fail).
    const adapter = new TessieAdapter("test-token", "WRONG_VIN", url);
    await assert.rejects(() => adapter.getState());
  } finally {
    await fake.stop();
  }
});

test("normalizeState falls back sanely on an empty/partial raw response", () => {
  const state = normalizeState({});
  assert.equal(state.odometerMiles, 0);
  assert.equal(state.batteryPercent, 0);
  assert.equal(state.chargingState, "Disconnected");
  // Absent lock telemetry must read as unknown, never a confirmed "unlocked" — that
  // false default is exactly the bug this null represents a fix for.
  assert.equal(state.locked, null);
  assert.equal(state.insideTempF, null);
  assert.equal(state.address, null);
});
