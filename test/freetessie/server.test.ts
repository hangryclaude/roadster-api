// server.ts against the fake Fleet API server, real tokenStore/fleetAuth/apiKeys/
// history/stateCache/fleetClient/commandMap, in-memory DatabaseSync — the whole stack
// except the real Tesla network and the real tesla-http-proxy sidecar.
//
// No test here exercises anything Autopilot/FSD/Summon/speed/drive-shaped: the closed-
// vocabulary test below proves the opposite (those names, and any name outside
// TESSIE_COMMANDS, 404 before ever reaching a Fleet call). See SPEC.md.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createApiKeyStore } from "../../src/freetessie/apiKeys.ts";
import { planCommand } from "../../src/freetessie/commandMap.ts";
import {
  TESLA_AUTHORIZE_URL,
  type FreeTessieConfig,
  type FreeTessieDeps,
} from "../../src/freetessie/contracts.ts";
import { createFakeFleetServer, type FakeFleetServer } from "../../src/freetessie/fakeFleetServer.ts";
import { createFleetAuth } from "../../src/freetessie/fleetAuth.ts";
import { createFleetClient } from "../../src/freetessie/fleetClient.ts";
import { createHistoryRecorder } from "../../src/freetessie/history.ts";
import { createLoginTokenStore } from "../../src/freetessie/loginTokens.ts";
import { createFreeTessieServer } from "../../src/freetessie/server.ts";
import { createStateCache } from "../../src/freetessie/stateCache.ts";
import { createTokenStore } from "../../src/freetessie/tokenStore.ts";
import { normalizeState } from "../../src/tesla/tessieAdapter.ts";

const VIN = "TEST000000000VIN";
const STUB_ADDRESS = "123 Stub St, Testville";

function configFor(url: string, geocode: FreeTessieConfig["geocode"]): FreeTessieConfig {
  return {
    clientId: "test-client",
    clientSecret: "test-secret",
    vin: VIN,
    region: "na",
    publicKeyDomain: "example.com",
    redirectUri: "https://example.com/auth/tesla/callback",
    publicKeyPem: null,
    signingProxyUrl: url,
    fleetBaseUrl: url,
    authBaseUrl: url,
    geocode,
  };
}

interface TestEnv {
  baseUrl: string;
  token: string;
  fake: FakeFleetServer;
  deps: FreeTessieDeps;
  /** mutable counter so a test can assert the cached path never re-geocodes */
  geocodeCalls: { count: number };
}

async function withServer(run: (env: TestEnv) => Promise<void>): Promise<void> {
  const fake = createFakeFleetServer(VIN);
  const { url: fakeUrl } = await fake.start();
  const db = new DatabaseSync(":memory:");
  const geocodeCalls = { count: 0 };
  const stubGeocode = async (): Promise<string | null> => {
    geocodeCalls.count++;
    return STUB_ADDRESS;
  };

  const config = configFor(fakeUrl, stubGeocode);
  const tokenStore = createTokenStore(db);
  const auth = createFleetAuth({ config, store: tokenStore });
  // Seed owner tokens via the fake token endpoint — the fake's authorization_code grant
  // doesn't validate the code at all, so any string works here (same as a test fixture).
  await auth.exchangeCode("seed-code");

  const apiKeys = createApiKeyStore(db);
  const { token } = apiKeys.mint("test key");

  const fleet = createFleetClient({ config, getAccessToken: () => auth.validAccessToken() });
  const deps: FreeTessieDeps = {
    config,
    db,
    auth,
    fleet,
    apiKeys,
    loginTokens: createLoginTokenStore(db),
    history: createHistoryRecorder(db),
    cache: createStateCache(db),
    planCommand,
  };

  const server = createFreeTessieServer(deps);
  const { url: baseUrl } = await server.start(0);

  try {
    await run({ baseUrl, token, fake, deps, geocodeCalls });
  } finally {
    await server.stop();
    await fake.stop();
    db.close();
  }
}

function authed(token: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } };
}

test("missing or wrong bearer is 401; right bearer wrong VIN is 404", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const noAuth = await fetch(`${baseUrl}/${VIN}/state`);
    assert.equal(noAuth.status, 401);

    const wrongToken = await fetch(`${baseUrl}/${VIN}/state`, authed("not-the-real-token"));
    assert.equal(wrongToken.status, 401);

    const wrongVin = await fetch(`${baseUrl}/OTHERVIN0000000000/state`, authed(token));
    assert.equal(wrongVin.status, 404);
    assert.deepEqual(await wrongVin.json(), { error: "vehicle not found" });
  });
});

test("GET /state before any read is 404 and makes zero Tesla calls", async () => {
  await withServer(async ({ baseUrl, token, deps }) => {
    const res = await fetch(`${baseUrl}/${VIN}/state`, authed(token));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "no cached state yet" });
    assert.equal(deps.fleet.counts.vehicleData, 0);
  });
});

test("GET /state?use_cache=false is live, Tessie-shaped, and warms the cache", async () => {
  await withServer(async ({ baseUrl, token, deps, geocodeCalls }) => {
    const live = await fetch(`${baseUrl}/${VIN}/state?use_cache=false`, authed(token));
    assert.equal(live.status, 200);
    const body = await live.json();

    // The whole point: TessieAdapter's own normalizeState() must parse this unchanged.
    const parsed = normalizeState(body);
    assert.equal(parsed.batteryPercent, 54);
    assert.equal(parsed.locked, true);
    assert.equal(parsed.address, STUB_ADDRESS);
    assert.equal(typeof parsed.updatedAt, "string");

    assert.equal(deps.fleet.counts.vehicleData, 1);
    assert.equal(geocodeCalls.count, 1);

    // Second read, no ?use_cache — served from cache: no new vehicle_data call, and no
    // re-geocode (the address came from the address cache, not a fresh Nominatim hit).
    const cached = await fetch(`${baseUrl}/${VIN}/state`, authed(token));
    assert.equal(cached.status, 200);
    const cachedBody = await cached.json();
    assert.equal(normalizeState(cachedBody).address, STUB_ADDRESS);
    assert.equal(deps.fleet.counts.vehicleData, 1);
    assert.equal(geocodeCalls.count, 1);
  });
});

test("unknown command names are rejected as 404 and never reach a Fleet call", async () => {
  await withServer(async ({ baseUrl, token, deps }) => {
    const autopilot = await fetch(`${baseUrl}/${VIN}/command/autopilot_on`, authed(token, { method: "POST" }));
    assert.equal(autopilot.status, 404);

    const summon = await fetch(`${baseUrl}/${VIN}/command/summon`, authed(token, { method: "POST" }));
    assert.equal(summon.status, 404);

    assert.equal(deps.fleet.counts.command, 0);
  });
});

test("lock/unlock go through the signed path and flip the fake's vehicle state", async () => {
  await withServer(async ({ baseUrl, token, fake, deps }) => {
    const unlock = await fetch(`${baseUrl}/${VIN}/command/unlock`, authed(token, { method: "POST" }));
    assert.deepEqual(await unlock.json(), { result: true });
    assert.equal(fake.state.vehicle_state.locked, false);

    const lock = await fetch(`${baseUrl}/${VIN}/command/lock`, authed(token, { method: "POST" }));
    assert.deepEqual(await lock.json(), { result: true });
    assert.equal(fake.state.vehicle_state.locked, true);

    assert.equal(deps.fleet.counts.command, 2);
  });
});

test("a command the virtual key rejects comes back as result:false, not an HTTP error", async () => {
  await withServer(async ({ baseUrl, token, fake }) => {
    fake.keyPaired = false;
    const res = await fetch(`${baseUrl}/${VIN}/command/lock`, authed(token, { method: "POST" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { result: false, reason: "virtual key missing" });
  });
});

test("share is routed to navigation_request, not the signed command path", async () => {
  await withServer(async ({ baseUrl, token, fake, deps }) => {
    const address = "1900 Park Ave, Denver, CO";
    const res = await fetch(
      `${baseUrl}/${VIN}/command/share?value=${encodeURIComponent(address)}`,
      authed(token, { method: "POST" }),
    );
    assert.deepEqual(await res.json(), { result: true });
    assert.equal(deps.fleet.counts.navigation, 1);
    assert.equal(deps.fleet.counts.command, 0);
    assert.equal(fake.navigationRequestsReceived.length, 1);
    const sent = fake.navigationRequestsReceived[0] as { value: Record<string, string> };
    assert.equal(sent.value["android.intent.extra.TEXT"], address);
  });
});

test("a dead token answers every protected route with 503 and a reconnect hint", async () => {
  await withServer(async ({ baseUrl, token, deps }) => {
    // Simulates risk #2 in the brief: a Tesla password change kills every token.
    // fleetAuth's own dead-token detection is already covered by fleetAuth.test.ts — this
    // drives tokenStore.markDead() directly to isolate server.ts's own handling of
    // DeadTokenError from deps.auth. createTokenStore is a thin view over the same table,
    // so a second handle on the same db still reaches the one row deps.auth reads.
    createTokenStore(deps.db).markDead();

    const command = await fetch(`${baseUrl}/${VIN}/command/wake`, authed(token, { method: "POST" }));
    assert.equal(command.status, 503);
    assert.deepEqual(await command.json(), {
      error: "tesla auth needs re-connecting",
      reconnect: "/auth/tesla/login",
    });

    const live = await fetch(`${baseUrl}/${VIN}/state?use_cache=false`, authed(token));
    assert.equal(live.status, 503);
    assert.deepEqual(await live.json(), {
      error: "tesla auth needs re-connecting",
      reconnect: "/auth/tesla/login",
    });
  });
});

test("the auth bootstrap routes refuse to touch a live connection", async () => {
  // withServer() seeds a live token up front — this is the "stranger reaches a
  // publicly-routed, already-connected server" scenario the already-connected guard
  // exists for: none of the three routes may mint a state or exchange a code while a
  // working token is already persisted.
  await withServer(async ({ baseUrl, token, deps }) => {
    const t = deps.loginTokens.mint();
    const login = await fetch(`${baseUrl}/auth/tesla/login?t=${t}`, { redirect: "manual" });
    assert.equal(login.status, 409);

    // Paste-the-code is bearer-gated: a stranger gets 401, the owner gets 409.
    const strangerCode = await fetch(`${baseUrl}/auth/tesla/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "attacker-code" }),
    });
    assert.equal(strangerCode.status, 401);
    const code = await fetch(
      `${baseUrl}/auth/tesla/code`,
      authed(token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "attacker-code" }),
      }),
    );
    assert.equal(code.status, 409);

    // callback's own state check runs first (no pending state exists, since login
    // above was refused before it ever minted one) — 400, never reaching exchangeCode.
    const callback = await fetch(`${baseUrl}/auth/tesla/callback?code=x&state=y`);
    assert.equal(callback.status, 400);
  });
});

test("GET /vehicles wraps Fleet's native shape in Tessie's {results:[{vin,is_active,last_state}]}", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const res = await fetch(`${baseUrl}/vehicles`, authed(token));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      results: Array<{ vin: string; is_active: boolean; last_state: unknown }>;
    };
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].vin, VIN);
    assert.equal(body.results[0].is_active, true);
    // No cache warmed yet in this test — last_state is still Tessie-shaped, just
    // all-undefined fields, not Fleet's native vehicle_data shape.
    assert.ok(body.results[0].last_state);
  });
});

test("GET /{vin}/status returns Tessie's {status} enum, not Fleet's native state", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const before = await fetch(`${baseUrl}/${VIN}/status`, authed(token));
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { status: "waiting_for_sleep" });

    // The fake's default vehicle state is "asleep" (no wake issued in this test).
    await fetch(`${baseUrl}/${VIN}/state?use_cache=false`, authed(token));
    const after = await fetch(`${baseUrl}/${VIN}/status`, authed(token));
    assert.deepEqual(await after.json(), { status: "asleep" });
  });
});

test("health and the well-known key path are unauthenticated", async () => {
  const fake = createFakeFleetServer(VIN);
  const { url: fakeUrl } = await fake.start();
  const db = new DatabaseSync(":memory:");
  try {
    const config = configFor(fakeUrl, undefined);
    const tokenStore = createTokenStore(db);
    const auth = createFleetAuth({ config, store: tokenStore });
    const withPem: FreeTessieDeps = {
      config: { ...config, publicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----" },
      db,
      auth,
      fleet: createFleetClient({ config, getAccessToken: () => auth.validAccessToken() }),
      apiKeys: createApiKeyStore(db),
      loginTokens: createLoginTokenStore(db),
      history: createHistoryRecorder(db),
      cache: createStateCache(db),
      planCommand,
    };
    const server = createFreeTessieServer(withPem);
    const { url: baseUrl } = await server.start(0);
    try {
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.equal(await health.text(), "ok");

      const pem = await fetch(`${baseUrl}/.well-known/appspecific/com.tesla.3p.public-key.pem`);
      assert.equal(pem.status, 200);
      assert.equal(pem.headers.get("content-type"), "application/x-pem-file");
      assert.match(await pem.text(), /BEGIN PUBLIC KEY/);
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
    db.close();
  }
});

test("well-known 404s when no public key is configured on this process", async () => {
  await withServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/.well-known/appspecific/com.tesla.3p.public-key.pem`);
    assert.equal(res.status, 404);
  });
});

test("auth bootstrap: login redirects with a fresh state, callback exchanges the code once", async () => {
  await withServer(async ({ baseUrl, deps }) => {
    // withServer() seeds a live token so every other test starts "connected" — kill it
    // here to exercise the reconnect-after-dead path the bootstrap routes exist for.
    createTokenStore(deps.db).markDead();

    // No one-time token, no login flow — this is the owner-only guard on bootstrap.
    const bare = await fetch(`${baseUrl}/auth/tesla/login`, { redirect: "manual" });
    assert.equal(bare.status, 403);
    const stale = await fetch(`${baseUrl}/auth/tesla/login?t=made-up`, { redirect: "manual" });
    assert.equal(stale.status, 403);

    const t = deps.loginTokens.mint();
    const login = await fetch(`${baseUrl}/auth/tesla/login?t=${t}`, { redirect: "manual" });
    assert.equal(login.status, 302);
    // The same link cannot start a second flow.
    const reuse = await fetch(`${baseUrl}/auth/tesla/login?t=${t}`, { redirect: "manual" });
    assert.equal(reuse.status, 403);
    const location = new URL(login.headers.get("location") ?? "");
    assert.equal(`${location.origin}${location.pathname}`, TESLA_AUTHORIZE_URL);
    const state = location.searchParams.get("state");
    assert.ok(state);

    const callback = await fetch(`${baseUrl}/auth/tesla/callback?code=abc123&state=${state}`);
    assert.equal(callback.status, 200);
    assert.equal(await callback.text(), "Tesla connected. You can close this tab.");
    // exchangeCode persisted a usable token — proven by asking for one, not by peeking
    // at TokenStore internals.
    assert.equal(typeof (await deps.auth.validAccessToken()), "string");

    // The same state can't be replayed once consumed.
    const replay = await fetch(`${baseUrl}/auth/tesla/callback?code=abc123&state=${state}`);
    assert.equal(replay.status, 400);
  });
});

test("POST /auth/tesla/code exchanges a pasted code for the holder of the local API key", async () => {
  await withServer(async ({ baseUrl, token, deps }) => {
    createTokenStore(deps.db).markDead();
    const res = await fetch(
      `${baseUrl}/auth/tesla/code`,
      authed(token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "pasted-code" }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "Tesla connected. You can close this tab.");
    assert.equal(typeof (await deps.auth.validAccessToken()), "string");
  });
});

test("window commands carry the car's own position; close is refused when none is known", async () => {
  await withServer(async ({ baseUrl, token, fake, deps }) => {
    // Nothing cached yet: exactly one live read to learn where the car is, then the
    // signed command goes out with those coordinates, not a placeholder.
    const close = await fetch(`${baseUrl}/${VIN}/command/close_windows`, authed(token, { method: "POST" }));
    assert.deepEqual(await close.json(), { result: true });
    assert.equal(deps.fleet.counts.vehicleData, 1);
    const sent = fake.commandsReceived.at(-1);
    assert.equal(sent?.name, "window_control");
    assert.equal(sent?.body.command, "close");
    assert.equal(sent?.body.lat, 39.7392);
    assert.equal(sent?.body.lon, -104.9903);

    // Cache is warm now: vent reuses it, no second billable read.
    const vent = await fetch(`${baseUrl}/${VIN}/command/vent_windows`, authed(token, { method: "POST" }));
    assert.deepEqual(await vent.json(), { result: true });
    assert.equal(deps.fleet.counts.vehicleData, 1);
    assert.equal(fake.commandsReceived.at(-1)?.body.command, "vent");
    assert.equal(fake.commandsReceived.at(-1)?.body.lat, 39.7392);
  });

  await withServer(async ({ baseUrl, token, fake, deps }) => {
    // No position in the data (e.g. vehicle_location scope not granted): close must not
    // be sent at all — a 0,0 placeholder would be rejected by the car and still billed.
    delete (fake.state.drive_state as Partial<typeof fake.state.drive_state>).latitude;
    const close = await fetch(`${baseUrl}/${VIN}/command/close_windows`, authed(token, { method: "POST" }));
    const body = (await close.json()) as { result: boolean; reason?: string };
    assert.equal(body.result, false);
    assert.match(body.reason ?? "", /location unknown/);
    assert.equal(deps.fleet.counts.command, 0);
  });
});

test("history routes answer in Tessie's snake_case shape and take from/to in seconds", async () => {
  await withServer(async ({ baseUrl, token, deps }) => {
    const t0 = 1_700_000_000_000;
    const snap = (odometer: number, shift: string | null, speed: number | null) => ({
      state: "online",
      vehicle_state: { odometer, locked: true },
      charge_state: { battery_level: 80, charging_state: "Disconnected" },
      drive_state: { latitude: 39.7, longitude: -104.9, shift_state: shift, speed },
    });
    deps.history.observe(snap(100, "P", null), t0);
    deps.history.observe(snap(100, "D", 30), t0 + 60_000);
    deps.history.observe(snap(110, "D", 40), t0 + 120_000);
    deps.history.observe(snap(110, "P", null), t0 + 180_000);

    const all = await fetch(`${baseUrl}/${VIN}/drives?from=${Math.floor(t0 / 1000)}`, authed(token));
    const drives = (await all.json()) as Array<Record<string, unknown>>;
    assert.equal(drives.length, 1);
    assert.equal(drives[0].starting_odometer, 100);
    assert.equal(drives[0].ending_odometer, 110);
    assert.equal(drives[0].odometer_distance, 10);
    assert.ok("started_at" in drives[0]);
    assert.ok(!("startedAt" in drives[0]));

    // A window that starts after the drive (in seconds) excludes it.
    const later = await fetch(`${baseUrl}/${VIN}/drives?from=${Math.floor(t0 / 1000) + 3600}`, authed(token));
    assert.equal(((await later.json()) as unknown[]).length, 0);
  });
});

test("cost invariant: a realistic scenario makes exactly the Tesla calls it should", async () => {
  // Turns the brief's §3/§5 cost-math promise into a check CI actually runs: one state
  // check (cached, empty, free), one live read, one repeat cached read (still free), one
  // wake, one signed command, one navigation share — and nothing else, ever.
  await withServer(async ({ baseUrl, token, deps }) => {
    await fetch(`${baseUrl}/${VIN}/state`, authed(token)); // 404, free
    await fetch(`${baseUrl}/${VIN}/state?use_cache=false`, authed(token)); // 1 vehicleData
    await fetch(`${baseUrl}/${VIN}/state`, authed(token)); // cached, free
    await fetch(`${baseUrl}/${VIN}/wake`, authed(token, { method: "POST" })); // 1 wake
    await fetch(`${baseUrl}/${VIN}/command/lock`, authed(token, { method: "POST" })); // 1 command
    await fetch(
      `${baseUrl}/${VIN}/command/share?value=${encodeURIComponent("1900 Park Ave")}`,
      authed(token, { method: "POST" }),
    ); // 1 navigation

    assert.deepEqual(deps.fleet.counts, {
      vehicleData: 1,
      wake: 1,
      command: 1,
      navigation: 1,
      fleetStatus: 0,
    });
  });
});
