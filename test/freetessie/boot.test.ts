// boot.ts: env-loading defaults/required-var checks, createFreeTessie's wiring, and
// bootFakeFleet's no-human-step token seeding. Exercises the real modules end to end
// against the fake Fleet server, same posture as server.test.ts.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { bootFakeFleet, createFreeTessie, loadFreeTessieConfigFromEnv } from "../../src/freetessie/boot.ts";

function fullEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    TESLA_CLIENT_ID: "client-1",
    TESLA_CLIENT_SECRET: "secret-1",
    TESLA_VIN: "TEST000000000VIN",
    TESLA_PUBLIC_KEY_DOMAIN: "example.com",
    ...overrides,
  };
}

test("loadFreeTessieConfigFromEnv applies documented defaults", () => {
  const { config, dbPath, port } = loadFreeTessieConfigFromEnv(fullEnv());
  assert.equal(config.region, "na");
  assert.equal(config.redirectUri, "https://example.com/auth/tesla/callback");
  assert.equal(config.signingProxyUrl, "https://127.0.0.1:4443");
  assert.equal(config.publicKeyPem, null);
  assert.equal(dbPath, "freetessie.db");
  assert.equal(port, 4000);
});

test("loadFreeTessieConfigFromEnv honors overrides", () => {
  const { config, dbPath, port } = loadFreeTessieConfigFromEnv(
    fullEnv({
      TESLA_REGION: "eu",
      TESLA_OAUTH_REDIRECT_URI: "https://custom.example/callback",
      TESLA_SIGNING_PROXY_URL: "https://127.0.0.1:9999",
      FREETESSIE_DB_PATH: "/tmp/custom-freetessie.db",
      FREETESSIE_PORT: "5050",
      FLEET_BASE_URL: "https://fake-fleet.test",
      FLEET_AUTH_URL: "https://fake-auth.test",
    }),
  );
  assert.equal(config.region, "eu");
  assert.equal(config.redirectUri, "https://custom.example/callback");
  assert.equal(config.signingProxyUrl, "https://127.0.0.1:9999");
  assert.equal(config.fleetBaseUrl, "https://fake-fleet.test");
  assert.equal(config.authBaseUrl, "https://fake-auth.test");
  assert.equal(dbPath, "/tmp/custom-freetessie.db");
  assert.equal(port, 5050);
});

test("loadFreeTessieConfigFromEnv throws on a missing required var", () => {
  const env = fullEnv();
  delete env.TESLA_CLIENT_SECRET;
  assert.throws(() => loadFreeTessieConfigFromEnv(env), /TESLA_CLIENT_SECRET/);
});

test("loadFreeTessieConfigFromEnv rejects an unknown region", () => {
  assert.throws(
    () => loadFreeTessieConfigFromEnv(fullEnv({ TESLA_REGION: "cn" })),
    /TESLA_REGION/,
  );
});

test("bootFakeFleet seeds tokens with no human step, createFreeTessie wires a working server", async () => {
  const db = new DatabaseSync(":memory:");
  const booted = await bootFakeFleet(db);
  try {
    // The seed lands in `db` before createFreeTessie ever touches it — a fresh
    // FleetAuth built on the same db must find it usable with no exchangeCode call
    // of its own (that's the "no human step" contract bootFakeFleet promises).
    const freetessie = createFreeTessie(booted.config, db);
    const accessToken = await freetessie.auth.validAccessToken();
    assert.ok(accessToken.length > 0);

    const { token } = freetessie.apiKeys.mint("boot test");
    const { url } = await freetessie.server.start(0);
    try {
      const res = await fetch(`${url}/${booted.config.vin}/command/lock`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { result: true });
      assert.equal(booted.fake.state.vehicle_state.locked, true);
    } finally {
      await freetessie.server.stop();
    }
  } finally {
    await booted.stop();
    db.close();
  }
});
