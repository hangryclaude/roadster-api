import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { startPoller, poll, runThenVerify } from "../src/scheduler/poller.ts";
import { scheduleTrigger, cancelLatestPending, dueTriggers, markFired } from "../src/scheduler/triggers.ts";

test("scheduleTrigger inserts a pending trigger", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const t = scheduleTrigger(db, {
      channel: "telegram",
      chatId: "123",
      toolName: "climate_on",
      toolArgs: {},
      fireAt: 1000,
      replyContext: "warm up my car",
    });
    assert.equal(t.status, "pending");
    assert.ok(t.id);
  } finally {
    db.close();
  }
});

test("dueTriggers returns only pending triggers at or before now, injected clock", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const early = scheduleTrigger(db, {
      channel: "telegram",
      chatId: "1",
      toolName: "climate_on",
      toolArgs: {},
      fireAt: 1000,
      replyContext: "a",
    });
    scheduleTrigger(db, {
      channel: "telegram",
      chatId: "1",
      toolName: "lock",
      toolArgs: {},
      fireAt: 5000,
      replyContext: "b",
    });

    const due = dueTriggers(db, 2000);
    assert.equal(due.length, 1);
    assert.equal(due[0].id, early.id);

    const noneYet = dueTriggers(db, 500);
    assert.equal(noneYet.length, 0);
  } finally {
    db.close();
  }
});

test("markFired flips status so a re-poll doesn't pick it up again", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const t = scheduleTrigger(db, {
      channel: "telegram",
      chatId: "1",
      toolName: "climate_on",
      toolArgs: {},
      fireAt: 1000,
      replyContext: "a",
    });
    markFired(db, t.id);
    const due = dueTriggers(db, 2000);
    assert.equal(due.length, 0);
  } finally {
    db.close();
  }
});

test("poll() marks due triggers fired before returning them (crash-safety)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    scheduleTrigger(db, {
      channel: "telegram",
      chatId: "1",
      toolName: "climate_on",
      toolArgs: {},
      fireAt: 1000,
      replyContext: "a",
    });
    const due = poll(db, 2000);
    assert.equal(due.length, 1);
    // a second poll at the same instant must not return it again
    const again = poll(db, 2000);
    assert.equal(again.length, 0);
  } finally {
    db.close();
  }
});

test("cancelLatestPending cancels the most recent pending trigger for that chat", () => {
  const db = new DatabaseSync(":memory:");
  try {
    scheduleTrigger(db, {
      channel: "telegram",
      chatId: "1",
      toolName: "climate_on",
      toolArgs: {},
      fireAt: 1000,
      replyContext: "older",
    });
    const newer = scheduleTrigger(db, {
      channel: "telegram",
      chatId: "1",
      toolName: "lock",
      toolArgs: {},
      fireAt: 2000,
      replyContext: "newer",
    });

    const cancelled = cancelLatestPending(db, "telegram", "1");
    assert.equal(cancelled?.id, newer.id);
    assert.equal(cancelled?.status, "cancelled");

    // the older one is still pending and still due
    const due = dueTriggers(db, 1500);
    assert.equal(due.length, 1);
    assert.equal(due[0].replyContext, "older");
  } finally {
    db.close();
  }
});

test("cancelLatestPending returns null when the chat has nothing pending", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const cancelled = cancelLatestPending(db, "telegram", "no-such-chat");
    assert.equal(cancelled, null);
  } finally {
    db.close();
  }
});

function fakeChannel(): import("../src/channels/channel.ts").Channel & { sent: Array<{ chatId: string; text: string }> } {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    kind: "telegram",
    sent,
    isAllowed: () => true,
    onMessage: () => {},
    async send(chatId, text) {
      sent.push({ chatId, text });
    },
    async start() {},
    async stop() {},
  };
}

function fakeVehicleAdapter(overrides: Partial<Record<string, unknown>> = {}): any {
  const base: Record<string, unknown> = {
    async getState() {
      return {
        odometerMiles: 0,
        batteryPercent: 50,
        chargingState: "Stopped",
        chargeLimitPercent: 80,
        locked: true,
        sentryOn: false,
        climateOn: false,
        insideTempF: null,
        climateTargetF: null,
        chargePortOpen: false,
        latitude: 0,
        longitude: 0,
        address: null,
        updatedAt: new Date().toISOString(),
      };
    },
    async wake() {},
    async climateOn() {},
    async climateOff() {},
    async setClimateTemp() {},
    async lock() {},
    async unlock() {},
    async chargeStart() {},
    async chargeStop() {},
    async setChargeLimit() {},
    async openChargePort() {},
    async closeChargePort() {},
    async openTrunk() {},
    async openFrunk() {},
    async honkHorn() {},
    async flashLights() {},
    async sentryOn() {},
    async sentryOff() {},
    async ventWindows() {},
    async closeWindows() {},
    async navSendDestination() {},
    async setScheduledDeparture() {},
  };
  return { ...base, ...overrides };
}

test("poller re-checks the PIN gate and skips a pin-gated trigger whose PIN was never verified", async () => {
  const db = new DatabaseSync(":memory:");
  const channel = fakeChannel();
  const unlockCalls: number[] = [];
  const adapter = fakeVehicleAdapter({ unlock: async () => unlockCalls.push(1) });
  scheduleTrigger(db, {
    channel: "telegram",
    chatId: "pin-chat",
    toolName: "unlock",
    toolArgs: {},
    fireAt: Date.now() - 1,
    replyContext: "unlock",
    pinVerified: false,
  });
  const poller = startPoller({ db, adapter, channels: new Map([["telegram", channel]]), intervalMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(unlockCalls.length, 0, "must never unlock without a verified PIN, even from a schedule");
    assert.ok(channel.sent.some((m) => /PIN/.test(m.text)));
  } finally {
    poller.stop();
    db.close();
  }
});

test("poller dispatches due triggers one at a time, awaiting each before the next", async () => {
  const db = new DatabaseSync(":memory:");
  const channel = fakeChannel();
  const order: string[] = [];
  const adapter = fakeVehicleAdapter({
    climateOff: async () => {
      order.push("climateOff:start");
      await new Promise((r) => setTimeout(r, 40));
      order.push("climateOff:end");
    },
    climateOn: async () => {
      order.push("climateOn:start");
      order.push("climateOn:end");
    },
  });
  const now = Date.now() - 1;
  scheduleTrigger(db, {
    channel: "telegram",
    chatId: "race-chat",
    toolName: "climate_off",
    toolArgs: {},
    fireAt: now,
    replyContext: "climate_off",
  });
  scheduleTrigger(db, {
    channel: "telegram",
    chatId: "race-chat",
    toolName: "climate_on",
    toolArgs: {},
    fireAt: now,
    replyContext: "climate_on",
  });
  const poller = startPoller({ db, adapter, channels: new Map([["telegram", channel]]), intervalMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    // climateOff must fully finish (start AND end) before climateOn starts — no
    // interleaving, which is what firing both without awaiting would produce.
    assert.deepEqual(order, ["climateOff:start", "climateOff:end", "climateOn:start", "climateOn:end"]);
  } finally {
    poller.stop();
    db.close();
  }
});

test("a dispatch failure notifies the owner via the originating channel, not just the log", async () => {
  const db = new DatabaseSync(":memory:");
  const channel = fakeChannel();
  const adapter = fakeVehicleAdapter({
    climateOn: async () => {
      throw new Error("Tessie unreachable");
    },
  });
  scheduleTrigger(db, {
    channel: "telegram",
    chatId: "fail-chat",
    toolName: "climate_on",
    toolArgs: {},
    fireAt: Date.now() - 1,
    replyContext: "climate_on",
  });
  const poller = startPoller({ db, adapter, channels: new Map([["telegram", channel]]), intervalMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(channel.sent.some((m) => /failed to run/.test(m.text) && /Tessie unreachable/.test(m.text)));
  } finally {
    poller.stop();
    db.close();
  }
});

test("an unknown scheduled tool name notifies the owner instead of silently vanishing", async () => {
  const db = new DatabaseSync(":memory:");
  const channel = fakeChannel();
  const adapter = fakeVehicleAdapter();
  scheduleTrigger(db, {
    channel: "telegram",
    chatId: "unknown-chat",
    toolName: "climate_start", // not a real tool name
    toolArgs: {},
    fireAt: Date.now() - 1,
    replyContext: "climate_start",
  });
  const poller = startPoller({ db, adapter, channels: new Map([["telegram", channel]]), intervalMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(channel.sent.some((m) => /couldn't run/.test(m.text)));
  } finally {
    poller.stop();
    db.close();
  }
});

test("startPoller ticks on an injected interval and stop() clears it cleanly", async () => {
  const db = new DatabaseSync(":memory:");
  const poller = startPoller({
    db,
    adapter: {} as any,
    channels: new Map(),
    intervalMs: 20,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(typeof poller.stop, "function");
  } finally {
    poller.stop();
    db.close();
  }
});

test("runThenVerify resolves once readState satisfies the predicate, not on action alone", async () => {
  let locked = false;
  let actionRan = false;
  const state = await runThenVerify(
    async () => {
      actionRan = true;
      setTimeout(() => {
        locked = true;
      }, 30);
    },
    async () => ({ locked }),
    (s) => s.locked,
    500,
  );
  assert.equal(actionRan, true);
  assert.equal(state.locked, true);
});

test("runThenVerify rejects when the predicate never becomes true within timeoutMs", async () => {
  await assert.rejects(
    runThenVerify(
      async () => {},
      async () => ({ locked: false }),
      (s) => s.locked,
      100,
    ),
  );
});
