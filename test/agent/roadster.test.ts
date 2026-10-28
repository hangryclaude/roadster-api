// The Roadster flight boundary: "land on the roof" reaches the model, the model picks
// roadster_flight, the tool answers honestly, and the vehicle adapter is never called.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { __resetPendingPinsForTests, handleInbound, hashPin } from "../../src/agent/agent.ts";
import type { VehicleAdapterLike } from "../../src/agent/types.ts";
import { fakeAdapter, fakeScheduler, scriptedClient } from "./helpers.ts";

// Wraps the fake adapter so every call is counted — a flight request must leave this at 0.
function countingAdapter() {
  const inner = fakeAdapter();
  const calls: string[] = [];
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && prop !== "constructor") {
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  }) as VehicleAdapterLike & { state: typeof inner.state };
  return { adapter: proxy, calls, state: inner.state };
}

test("'land on the roof' -> roadster_flight -> honest reply, zero vehicle calls", async () => {
  __resetPendingPinsForTests();
  const client = scriptedClient([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "roadster_flight", input: { command: "land", where: "the roof" } }],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Can't yet — Tesla hasn't shipped the flight endpoints. The day they do." }] },
  ]);
  const { adapter, calls, state } = countingAdapter();
  const db = new DatabaseSync(":memory:");
  try {
    const reply = await handleInbound(
      { client, adapter, scheduler: fakeScheduler(), db, userPinHash: hashPin("4471") },
      { channel: "telegram", chatId: "r1", text: "land on the roof" },
    );
    assert.match(reply, /hasn't shipped|haven't|hasn't published|day they/i);
    assert.deepEqual(calls, [], "a flight request must never touch the vehicle adapter");
    assert.equal(state.locked, true);
    assert.equal(state.climateOn, false);

    // The tool result the model saw is the honest manifest answer.
    const second = client.calls[1];
    const toolResults = second.messages[second.messages.length - 1].content as Array<{ content: string }>;
    assert.match(toolResults[0].content, /awaiting_fleet_api/);
    assert.match(toolResults[0].content, /hasn't published Roadster flight endpoints yet \(production target 2028\)/);
    assert.match(toolResults[0].content, /Nothing was sent to the car/);
    assert.match(toolResults[0].content, /\(the roof\)/);

    // The system prompt introduces the assistant as Roadster and names the flight commands.
    assert.match(client.calls[0].system, /You are Roadster/);
    assert.match(client.calls[0].system, /land, hover, jump, thrust_mode/);
  } finally {
    db.close();
  }
});

test("an unknown flight command is answered from the manifest, still without a vehicle call", async () => {
  __resetPendingPinsForTests();
  const client = scriptedClient([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "roadster_flight", input: { command: "barrel_roll" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Not a thing yet." }] },
  ]);
  const { adapter, calls } = countingAdapter();
  const db = new DatabaseSync(":memory:");
  try {
    await handleInbound(
      { client, adapter, scheduler: fakeScheduler(), db, userPinHash: hashPin("4471") },
      { channel: "telegram", chatId: "r2", text: "do a barrel roll" },
    );
    const second = client.calls[1];
    const toolResults = second.messages[second.messages.length - 1].content as Array<{ content: string }>;
    assert.match(toolResults[0].content, /isn't a Roadster flight command I know; the manifest has: land, hover, jump, thrust_mode/);
    assert.deepEqual(calls, []);
  } finally {
    db.close();
  }
});

test("the driving refusal still fires before the model for a self-drive request, flight or not", async () => {
  __resetPendingPinsForTests();
  const client = scriptedClient([]);
  const { adapter, calls } = countingAdapter();
  const db = new DatabaseSync(":memory:");
  try {
    const reply = await handleInbound(
      { client, adapter, scheduler: fakeScheduler(), db, userPinHash: hashPin("4471") },
      { channel: "telegram", chatId: "r3", text: "fly it here on autopilot and land in the driveway" },
    );
    assert.match(reply, /can't touch Autopilot/);
    assert.equal(client.calls.length, 0, "model must not be consulted");
    assert.deepEqual(calls, []);
  } finally {
    db.close();
  }
});
