// fleetAuth against a tiny node:http fake of Tesla's token endpoint — not the real
// Fleet API host, just enough to script success/401/500 responses and inspect the
// exact form fields sent, per docs/FREETESSIE-BRIEF.md §5 ("new fake, at the Fleet
// API layer"). This covers only auth/token plumbing — see SPEC.md for this repo's
// scope limits on what any vehicle command surface may ever do.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DeadTokenError, type FreeTessieConfig, type OwnerTokens } from "../../src/freetessie/contracts.ts";
import { createFleetAuth } from "../../src/freetessie/fleetAuth.ts";
import { createTokenStore } from "../../src/freetessie/tokenStore.ts";

interface ScriptedResponse {
  status: number;
  body: Record<string, unknown> | string;
}

interface FakeTokenServer {
  url: string;
  requests: URLSearchParams[];
  stop(): Promise<void>;
}

// Each incoming POST consumes the next scripted response in order; once the list is
// exhausted, the last entry repeats (so a single-success script still answers a
// second, unexpected call instead of hanging the test).
function startFakeTokenServer(responses: ScriptedResponse[]): Promise<FakeTokenServer> {
  const requests: URLSearchParams[] = [];
  let callIndex = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
      const next = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
      res.writeHead(next.status, { "Content-Type": "application/json" });
      res.end(text);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function baseConfig(authBaseUrl: string): FreeTessieConfig {
  return {
    clientId: "client-123",
    clientSecret: "secret-abc",
    vin: "TEST000000000VIN",
    region: "na",
    publicKeyDomain: "example.com",
    redirectUri: "https://example.com/auth/tesla/callback",
    publicKeyPem: null,
    signingProxyUrl: "https://127.0.0.1:4443",
    authBaseUrl,
  };
}

function successBody(accessToken: string, refreshToken: string): ScriptedResponse {
  return {
    status: 200,
    body: { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, scope: "openid" },
  };
}

const LOGIN_REQUIRED: ScriptedResponse = { status: 401, body: { error: "login_required" } };

test("exchangeCode persists the returned tokens", async () => {
  const fake = await startFakeTokenServer([successBody("at-1", "rt-1")]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = createTokenStore(db);
    const auth = createFleetAuth({ config: baseConfig(fake.url), store });

    const tokens = await auth.exchangeCode("auth-code-xyz");

    assert.equal(tokens.accessToken, "at-1");
    assert.equal(tokens.refreshToken, "rt-1");
    assert.equal(tokens.dead, false);
    assert.deepEqual(store.load(), tokens);

    const sent = fake.requests[0];
    assert.equal(sent.get("grant_type"), "authorization_code");
    assert.equal(sent.get("code"), "auth-code-xyz");
    assert.equal(sent.get("client_secret"), "secret-abc");
    assert.equal(sent.get("audience"), "https://fleet-api.prd.na.vn.cloud.tesla.com");
  } finally {
    db.close();
    await fake.stop();
  }
});

test("refresh rotates the refresh token and persists before resolving", async () => {
  const fake = await startFakeTokenServer([successBody("at-2", "rt-2-rotated")]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = createTokenStore(db);
    const auth = createFleetAuth({ config: baseConfig(fake.url), store });
    const current: OwnerTokens = {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() - 1000, // already expired, irrelevant to refresh() directly
      scope: "openid",
      dead: false,
    };
    store.save(current);

    const refreshed = await auth.refresh(current);

    assert.equal(refreshed.accessToken, "at-2");
    assert.equal(refreshed.refreshToken, "rt-2-rotated");
    // By the time refresh() resolves, the rotated token must already be durable —
    // not "about to be written" on some later tick.
    assert.deepEqual(store.load(), refreshed);

    const sent = fake.requests[0];
    assert.equal(sent.get("grant_type"), "refresh_token");
    assert.equal(sent.get("refresh_token"), "rt-1");
    assert.equal(sent.has("client_secret"), false, "refresh grant must not send client_secret");
  } finally {
    db.close();
    await fake.stop();
  }
});

test("login_required on refresh marks the store dead and throws DeadTokenError", async () => {
  const fake = await startFakeTokenServer([LOGIN_REQUIRED]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = createTokenStore(db);
    const auth = createFleetAuth({ config: baseConfig(fake.url), store });
    const current: OwnerTokens = {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() - 1000,
      scope: "openid",
      dead: false,
    };
    store.save(current);

    await assert.rejects(() => auth.refresh(current), DeadTokenError);
    assert.equal(store.load()?.dead, true);
  } finally {
    db.close();
    await fake.stop();
  }
});

test("a transient 500 does not mark the token dead; a later refresh can still succeed", async () => {
  const fake = await startFakeTokenServer([
    { status: 500, body: { error: "internal" } },
    successBody("at-3", "rt-3"),
  ]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = createTokenStore(db);
    const auth = createFleetAuth({ config: baseConfig(fake.url), store });
    const current: OwnerTokens = {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() - 1000,
      scope: "openid",
      dead: false,
    };
    store.save(current);

    await assert.rejects(() => auth.refresh(current), (err: unknown) => {
      assert.ok(!(err instanceof DeadTokenError), "a transient 500 must not read as login_required");
      return true;
    });
    assert.equal(store.load()?.dead, false, "a transient failure must not mark the store dead");
    assert.deepEqual(store.load(), current, "a failed refresh must not overwrite the still-good tokens");

    const retried = await auth.refresh(current);
    assert.equal(retried.accessToken, "at-3");
    assert.deepEqual(store.load(), retried);
  } finally {
    db.close();
    await fake.stop();
  }
});

test("validAccessToken returns the cached token without a network call when far from expiry", async () => {
  const fake = await startFakeTokenServer([successBody("should-not-be-used", "rt-x")]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = createTokenStore(db);
    const auth = createFleetAuth({ config: baseConfig(fake.url), store });
    store.save({
      accessToken: "at-fresh",
      refreshToken: "rt-fresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "openid",
      dead: false,
    });

    const token = await auth.validAccessToken();

    assert.equal(token, "at-fresh");
    assert.equal(fake.requests.length, 0, "a token with plenty of life left must not trigger a refresh");
  } finally {
    db.close();
    await fake.stop();
  }
});

test("validAccessToken refreshes when fewer than 5 minutes remain", async () => {
  const fake = await startFakeTokenServer([successBody("at-renewed", "rt-renewed")]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = createTokenStore(db);
    const auth = createFleetAuth({ config: baseConfig(fake.url), store });
    store.save({
      accessToken: "at-stale",
      refreshToken: "rt-stale",
      expiresAt: Date.now() + 60 * 1000, // 1 minute left, under the 5-minute margin
      scope: "openid",
      dead: false,
    });

    const token = await auth.validAccessToken();

    assert.equal(token, "at-renewed");
    assert.equal(fake.requests.length, 1);
    assert.equal(store.load()?.accessToken, "at-renewed");
  } finally {
    db.close();
    await fake.stop();
  }
});

test("validAccessToken throws DeadTokenError when the store is empty or dead", async () => {
  const fake = await startFakeTokenServer([successBody("unused", "unused")]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = createTokenStore(db);
    const auth = createFleetAuth({ config: baseConfig(fake.url), store });

    await assert.rejects(() => auth.validAccessToken(), DeadTokenError);

    store.save({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "openid",
      dead: true,
    });
    await assert.rejects(() => auth.validAccessToken(), DeadTokenError);
    assert.equal(fake.requests.length, 0, "a dead token must never reach the network");
  } finally {
    db.close();
    await fake.stop();
  }
});

test("concurrent validAccessToken calls near expiry trigger exactly one refresh", async () => {
  const fake = await startFakeTokenServer([successBody("at-single-flight", "rt-single-flight")]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = createTokenStore(db);
    const auth = createFleetAuth({ config: baseConfig(fake.url), store });
    store.save({
      accessToken: "at-stale",
      refreshToken: "rt-stale",
      expiresAt: Date.now() + 60 * 1000,
      scope: "openid",
      dead: false,
    });

    const [a, b, c] = await Promise.all([
      auth.validAccessToken(),
      auth.validAccessToken(),
      auth.validAccessToken(),
    ]);

    assert.equal(fake.requests.length, 1, "three concurrent callers near expiry must share one refresh");
    assert.equal(a, "at-single-flight");
    assert.equal(b, "at-single-flight");
    assert.equal(c, "at-single-flight");
  } finally {
    db.close();
    await fake.stop();
  }
});

test("partnerToken is never persisted to the token store", async () => {
  const fake = await startFakeTokenServer([{ status: 200, body: { access_token: "partner-at", expires_in: 300 } }]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = createTokenStore(db);
    const auth = createFleetAuth({ config: baseConfig(fake.url), store });

    const token = await auth.partnerToken();

    assert.equal(token, "partner-at");
    assert.equal(store.load(), null);
    assert.equal(fake.requests[0].get("grant_type"), "client_credentials");
    assert.equal(fake.requests[0].get("audience"), "https://fleet-api.prd.na.vn.cloud.tesla.com");
    // Partner tokens must request a restricted scope set — offline_access controls
    // refresh issuance (meaningless for client_credentials) and vehicle_location is
    // per-vehicle-consent, not partner-level; asking for either risks invalid_scope.
    const partnerScope = fake.requests[0].get("scope");
    assert.ok(!partnerScope?.includes("offline_access"), "partner token must not request offline_access");
    assert.ok(!partnerScope?.includes("vehicle_location"), "partner token must not request vehicle_location");
  } finally {
    db.close();
    await fake.stop();
  }
});

test("authorizeUrl carries the owner scopes, redirect_uri and state", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createTokenStore(db);
    const auth = createFleetAuth({ config: baseConfig("http://127.0.0.1:1"), store });
    const url = new URL(auth.authorizeUrl("state-abc"));
    assert.equal(url.origin + url.pathname, "https://auth.tesla.com/oauth2/v3/authorize");
    assert.equal(url.searchParams.get("client_id"), "client-123");
    assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/auth/tesla/callback");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("state"), "state-abc");
    assert.ok(url.searchParams.get("scope")?.includes("offline_access"));
    assert.ok(url.searchParams.get("scope")?.includes("vehicle_location"));
  } finally {
    db.close();
  }
});
