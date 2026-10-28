import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApiKeyStore } from "../../src/freetessie/apiKeys.ts";

test("mint then verify returns true", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createApiKeyStore(db);
    const { token } = store.mint("telegram bot");
    assert.equal(store.verify(token), true);
  } finally {
    db.close();
  }
});

test("a wrong token fails verify", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createApiKeyStore(db);
    store.mint("telegram bot");
    assert.equal(store.verify("not-the-real-token"), false);
  } finally {
    db.close();
  }
});

test("a revoked key fails verify even with the right token", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createApiKeyStore(db);
    const { id, token } = store.mint("telegram bot");
    assert.equal(store.verify(token), true);
    store.revoke(id);
    assert.equal(store.verify(token), false);
    const record = store.list().find((r) => r.id === id);
    assert.ok(record?.revokedAt != null);
  } finally {
    db.close();
  }
});

test("the plaintext token is never stored in the table", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createApiKeyStore(db);
    const { token } = store.mint("telegram bot");
    const rows = db.prepare(`SELECT * FROM api_keys`).all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") {
          assert.ok(!value.includes(token), "plaintext token leaked into a stored column");
        }
      }
    }
  } finally {
    db.close();
  }
});

test("list reflects multiple keys and independent revocation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createApiKeyStore(db);
    const a = store.mint("a");
    const b = store.mint("b");
    store.revoke(a.id);
    assert.equal(store.verify(a.token), false);
    assert.equal(store.verify(b.token), true);
    const records = store.list();
    assert.equal(records.length, 2);
  } finally {
    db.close();
  }
});
