// The vehicle profile reaches the system prompt: a Cybertruck is named as such and is
// never offered the Roadster's flight commands; the default stays the Roadster.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { __resetPendingPinsForTests, handleInbound, hashPin } from "../../src/agent/agent.ts";
import { fakeAdapter, fakeScheduler, scriptedClient } from "./helpers.ts";

const endTurn = (text: string) => ({ stop_reason: "end_turn" as const, content: [{ type: "text" as const, text }] });

test("a Cybertruck's system prompt names the Cybertruck and offers no flight commands", async () => {
  __resetPendingPinsForTests();
  const client = scriptedClient([endTurn("Hi.")]);
  const db = new DatabaseSync(":memory:");
  try {
    await handleInbound(
      { client, adapter: fakeAdapter(), scheduler: fakeScheduler(), db, userPinHash: hashPin("4471"), vehicleModel: "cybertruck" },
      { channel: "telegram", chatId: "v1", text: "hi" },
    );
    const system = client.calls[0].system;
    assert.match(system, /Tesla Cybertruck/);
    assert.match(system, /cargo bed/);
    assert.match(system, /no flight commands/);
    assert.doesNotMatch(system, /\bland, hover, jump, thrust_mode\b/);
    assert.doesNotMatch(system, /call roadster_flight/);
  } finally {
    db.close();
  }
});

test("with no vehicleModel the prompt is the Roadster's, flight commands included", async () => {
  __resetPendingPinsForTests();
  const client = scriptedClient([endTurn("Hi.")]);
  const db = new DatabaseSync(":memory:");
  try {
    await handleInbound(
      { client, adapter: fakeAdapter(), scheduler: fakeScheduler(), db, userPinHash: hashPin("4471") },
      { channel: "telegram", chatId: "v2", text: "hi" },
    );
    const system = client.calls[0].system;
    assert.match(system, /Tesla Roadster/);
    assert.match(system, /land, hover, jump, thrust_mode/);
  } finally {
    db.close();
  }
});
