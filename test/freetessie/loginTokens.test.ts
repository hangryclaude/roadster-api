// LoginTokenStore: one-time, hashed, expiring. The owner-only guard on /auth/tesla/login.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createLoginTokenStore } from "../../src/freetessie/loginTokens.ts";

test("a minted token is consumed exactly once", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createLoginTokenStore(db);
    const t = store.mint();
    assert.equal(store.consume(t), true);
    assert.equal(store.consume(t), false);
    assert.equal(store.consume("not-a-token"), false);
  } finally {
    db.close();
  }
});

test("plaintext is never stored and an expired token is refused", () => {
  const db = new DatabaseSync(":memory:");
  try {
    let now = 1_700_000_000_000;
    const store = createLoginTokenStore(db, () => now);
    const t = store.mint();
    const rows = db.prepare(`SELECT hash FROM login_tokens`).all() as Array<{ hash: string }>;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].hash, t);

    now += 16 * 60 * 1000; // past the 15-minute window
    assert.equal(store.consume(t), false);
  } finally {
    db.close();
  }
});
