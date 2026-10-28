import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { addTurn, ensureMemorySchema, getRecentTurns } from "../../src/agent/memory.ts";

test("keeps only the last 20 turns per chat", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureMemorySchema(db);
    for (let i = 0; i < 25; i++) {
      addTurn(db, "chat1", i % 2 === 0 ? "user" : "assistant", `turn ${i}`);
    }
    const turns = getRecentTurns(db, "chat1");
    assert.equal(turns.length, 20);
    assert.equal(turns[0].content, "turn 5");
    assert.equal(turns[19].content, "turn 24");
  } finally {
    db.close();
  }
});

test("chats don't leak into each other's memory", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureMemorySchema(db);
    addTurn(db, "chatA", "user", "hello from A");
    addTurn(db, "chatB", "user", "hello from B");
    assert.deepEqual(getRecentTurns(db, "chatA").map((t) => t.content), ["hello from A"]);
    assert.deepEqual(getRecentTurns(db, "chatB").map((t) => t.content), ["hello from B"]);
  } finally {
    db.close();
  }
});
