import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeTessie } from "./fakeTessie.ts";

test("fake tessie server starts and stops cleanly", async () => {
  const fake = startFakeTessie();
  try {
    assert.ok(fake.url.startsWith("http://127.0.0.1:"));
  } finally {
    await fake.close();
  }
});
