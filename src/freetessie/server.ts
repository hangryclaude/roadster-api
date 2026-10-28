// FreeTessie's own Hono app — the Tessie-compatible REST surface that
// src/tesla/tessieAdapter.ts talks to unchanged. Route table is the comment block at the
// bottom of contracts.ts; this file implements exactly that, nothing more.
//
// Same hard rule as everywhere else in this repo: nothing here is, or routes to, anything
// Autopilot/FSD/Summon/speed/drive-shaped. The only command surface a caller can reach is
// deps.planCommand's closed TESSIE_COMMANDS vocabulary — an unknown name 404s, it never
// forwards anywhere.

import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { randomBytes } from "node:crypto";

import {
  CommandError,
  DeadTokenError,
  PUBLIC_KEY_PATH,
  UnknownCommandError,
  type FleetVehicleData,
  type FreeTessieDeps,
  type FreeTessieServer,
} from "./contracts.ts";
import { reverseGeocode } from "./geocode.ts";
import { toTessieChargeWire, toTessieDriveWire, toTessieIdleWire } from "./history.ts";
import { toTessieBattery, toTessieLocation, toTessieState } from "./tessieShape.ts";

const DEAD_TOKEN_BODY = {
  error: "tesla auth needs re-connecting",
  reconnect: "/auth/tesla/login",
} as const;

// ---------------------------------------------------------------------------
// Address cache — the one piece of per-vehicle state this module keeps itself.
// StateCache (contracts.ts, locked) only persists FleetVehicleData, which has no
// address field; a live read's reverse-geocoded address has to live somewhere so the
// cached (never-calls-Tesla, never-calls-Nominatim-either) path can still answer with
// the last-known address instead of silently dropping it. Single row, same upsert
// idiom as stateCache.ts/tokenStore.ts.
// ---------------------------------------------------------------------------

function ensureAddressCache(db: FreeTessieDeps["db"]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS freetessie_resolved_address (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      address TEXT
    )
  `);
}

function readResolvedAddress(db: FreeTessieDeps["db"]): string | null {
  const row = db
    .prepare(`SELECT address FROM freetessie_resolved_address WHERE id = 1`)
    .get() as { address: string | null } | undefined;
  return row ? row.address : null;
}

function writeResolvedAddress(db: FreeTessieDeps["db"], address: string | null): void {
  db.prepare(
    `INSERT INTO freetessie_resolved_address (id, address) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET address = excluded.address`,
  ).run(address);
}

interface Snapshot {
  data: FleetVehicleData;
  address: string | null;
  fetchedAt: number;
}

// Shared by /state, /battery, /location: cached (default) never touches Tesla or
// Nominatim; live (?use_cache=false) does the one billable vehicle_data read, feeds it
// into the cache + history recorder + address cache, and returns it fresh. Throws
// DeadTokenError straight through — callers decide how to answer that.
async function getSnapshot(deps: FreeTessieDeps, live: boolean): Promise<Snapshot | null> {
  if (!live) {
    const cached = deps.cache.get();
    if (!cached) return null;
    return { data: cached.data, address: readResolvedAddress(deps.db), fetchedAt: cached.fetchedAt };
  }

  const data = await deps.fleet.vehicleData();
  const fetchedAt = Date.now();
  deps.cache.put(data, fetchedAt);
  deps.history.observe(data, fetchedAt);

  const geocode = deps.config.geocode ?? reverseGeocode;
  const lat = data.drive_state?.latitude;
  const lon = data.drive_state?.longitude;
  const address = typeof lat === "number" && typeof lon === "number" ? await geocode(lat, lon) : null;
  writeResolvedAddress(deps.db, address);

  return { data, address, fetchedAt };
}

function isLive(c: Context): boolean {
  return c.req.query("use_cache") === "false";
}

// The car's own last-known position, for the proximity-gated window commands. Uses the
// cache when warm; otherwise spends exactly one live read (billable, counted) rather than
// sending Tesla a placeholder it would reject anyway.
async function vehicleLocation(deps: FreeTessieDeps): Promise<{ lat: number; lon: number } | null> {
  const data = deps.cache.get()?.data ?? (await getSnapshot(deps, true))?.data;
  const lat = data?.drive_state?.latitude;
  const lon = data?.drive_state?.longitude;
  return typeof lat === "number" && typeof lon === "number" ? { lat, lon } : null;
}

// Guards the three OAuth-bootstrap routes against overwriting a working connection: once
// the owner has a live (non-dead) token, nothing should be able to mint a fresh login
// state or exchange a fresh code and clobber fleet_tokens' single row out from under
// them. Same broad catch as /:vin/status below — any failure (dead token, or anything
// else going wrong while checking) reads as "not connected," which is the safe default
// here since it only widens who *can* attempt a (re-)login, never who can skip it.
// This does not close the narrower window where no owner has connected yet (or the
// token is deliberately dead for a reconnect) and a stranger reaches these routes before
// the real owner does — that needs an owner-only secret on the bootstrap flow itself,
// which is a contracts.ts change (see contract_changes_needed), not something this file
// can add without widening the locked FreeTessieConfig/route-table shape.
async function alreadyConnected(deps: FreeTessieDeps): Promise<boolean> {
  try {
    await deps.auth.validAccessToken();
    return true;
  } catch {
    return false;
  }
}

// GET /state, /battery, /location share this shape exactly: resolve a snapshot (cached
// or live per ?use_cache), 404 when there's nothing cached yet, 503+reconnect when the
// live path finds the owner's tokens dead, otherwise hand the snapshot to `shape`.
async function snapshotRoute(
  c: Context,
  deps: FreeTessieDeps,
  shape: (snap: Snapshot) => unknown,
): Promise<Response> {
  let snap: Snapshot | null;
  try {
    snap = await getSnapshot(deps, isLive(c));
  } catch (err) {
    if (err instanceof DeadTokenError) return c.json(DEAD_TOKEN_BODY, 503);
    throw err;
  }
  if (!snap) return c.json({ error: "no cached state yet" }, 404);
  return c.json(shape(snap) as Record<string, unknown>);
}

// Tessie's /drives, /charges, /idles take from/to as unix seconds; history.ts stores ms.
// A value past 1e11 can only be ms (that many seconds is the year 5138), so a client that
// sends ms by habit still gets the right window instead of an empty one.
function rangeParams(c: Context): { from?: number; to?: number } {
  const toMs = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return n > 1e11 ? n : n * 1000;
  };
  return { from: toMs(c.req.query("from")), to: toMs(c.req.query("to")) };
}

// POST /{vin}/wake, /{vin}/command/wake, and /{vin}/command/{name} all funnel through
// here. Tessie's own convention (tessieAdapter.ts's command() checks `result === false`,
// never the HTTP status) is HTTP 200 with {result:false, reason} for anything that isn't
// an unknown-name or a dead-token — including a plain wake() timeout, which isn't a
// CommandError but still needs to come back as a result the caller can read, not a 500.
async function runCommand(c: Context, deps: FreeTessieDeps, name: string): Promise<Response> {
  const query: Record<string, string> = { ...c.req.query() };

  // Tesla's window_control is proximity-gated on close. TessieAdapter sends no
  // coordinates (real Tessie resolves them server-side), so the car's own position goes
  // into the query here; close is refused outright when no position is known, because a
  // placeholder would be rejected by the car and still billed.
  if (name === "vent_windows" || name === "close_windows") {
    let loc: { lat: number; lon: number } | null;
    try {
      loc = await vehicleLocation(deps);
    } catch (err) {
      if (err instanceof DeadTokenError) return c.json(DEAD_TOKEN_BODY, 503);
      throw err;
    }
    if (loc) {
      query.lat = String(loc.lat);
      query.lon = String(loc.lon);
    } else if (name === "close_windows") {
      return c.json({
        result: false,
        reason: "vehicle location unknown; cannot close windows (is the vehicle_location scope granted?)",
      });
    }
  }

  let plan;
  try {
    plan = deps.planCommand(name, query);
  } catch (err) {
    if (err instanceof UnknownCommandError) return c.json({ error: err.message }, 404);
    return c.json({ error: (err as Error).message }, 400);
  }

  try {
    if (plan.kind === "wake") {
      await deps.fleet.wake();
    } else if (plan.kind === "signed") {
      await deps.fleet.signedCommand(plan.name, plan.body);
    } else {
      await deps.fleet.navigationRequest(plan.address);
    }
    return c.json({ result: true });
  } catch (err) {
    if (err instanceof DeadTokenError) return c.json(DEAD_TOKEN_BODY, 503);
    const reason = err instanceof CommandError ? err.reason : (err as Error).message;
    return c.json({ result: false, reason });
  }
}

// Paths reachable with no bearer at all: the browser half of the OAuth bootstrap (guarded
// by a one-time login token instead, see /auth/tesla/login) and the two routes anyone may
// hit by Tessie's own convention and this repo's /health idiom.
function unauthenticatedPaths(): Set<string> {
  return new Set(["/health", PUBLIC_KEY_PATH, "/auth/tesla/login", "/auth/tesla/callback"]);
}

// Bearer-gated paths that are not "/{vin}/..." and so skip the VIN check.
const BEARER_ONLY_PATHS = new Set(["/vehicles", "/auth/tesla/code"]);

export function createFreeTessieServer(deps: FreeTessieDeps): FreeTessieServer {
  ensureAddressCache(deps.db);

  const app = new Hono();
  const openPaths = unauthenticatedPaths();
  // state -> expiry (ms); 10-minute window on the one-time OAuth state token.
  const pendingLoginStates = new Map<string, number>();
  const STATE_TTL_MS = 10 * 60 * 1000;

  // Single auth gate, checked by raw path rather than Hono route patterns: a pattern
  // like "/:vin/*" would also match "/auth/tesla/login" (any first segment + anything
  // after it matches a one-param wildcard), which would wrongly bearer-gate the very
  // bootstrap flow that mints the bearer token. Explicit path comparison sidesteps that.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (openPaths.has(path)) return next();

    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !deps.apiKeys.verify(token)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    if (BEARER_ONLY_PATHS.has(path)) return next();

    // Every other authenticated path is "/{vin}/...": the owner only ever mints keys
    // for their own one car, so a different VIN here is a probe, not a real client —
    // 404 rather than 401 so it reads as "no such vehicle," not "bad key."
    const vin = path.split("/").filter(Boolean)[0];
    if (vin !== deps.config.vin) {
      return c.json({ error: "vehicle not found" }, 404);
    }
    return next();
  });

  app.get("/health", (c) => c.text("ok"));

  app.get(PUBLIC_KEY_PATH, (c) => {
    if (!deps.config.publicKeyPem) return c.notFound();
    return c.body(deps.config.publicKeyPem, 200, { "Content-Type": "application/x-pem-file" });
  });

  app.get("/auth/tesla/login", async (c) => {
    // A live connection already exists — refuse to mint a fresh state rather than hand
    // out a working login flow that would end by overwriting it. See alreadyConnected().
    if (await alreadyConnected(deps)) {
      return c.json({ error: "already connected; Tesla auth is already live" }, 409);
    }
    // Owner-only: this route runs in a browser before any bearer exists, so the proof
    // of ownership is a one-time token minted on the operator's own machine
    // (`npm run freetessie:setup -- login-url`). Without it a stranger who found the
    // public domain could connect THEIR Tesla here first and own the single token row.
    const t = c.req.query("t") ?? "";
    if (!t || !deps.loginTokens.consume(t)) {
      return c.text("login link required: run `npm run freetessie:setup -- login-url` and open the printed link", 403);
    }
    const now = Date.now();
    for (const [state, expiresAt] of pendingLoginStates) {
      if (expiresAt <= now) pendingLoginStates.delete(state);
    }
    const state = randomBytes(16).toString("hex");
    pendingLoginStates.set(state, now + STATE_TTL_MS);
    return c.redirect(deps.auth.authorizeUrl(state), 302);
  });

  app.get("/auth/tesla/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const expiresAt = state ? pendingLoginStates.get(state) : undefined;
    if (!code || !state || !expiresAt || expiresAt <= Date.now()) {
      if (state) pendingLoginStates.delete(state);
      return c.text("invalid or expired state", 400);
    }
    pendingLoginStates.delete(state);
    // Re-checked here too: the state could have been minted before a connection existed
    // and only completed after another flow (or the owner themselves) already connected.
    if (await alreadyConnected(deps)) {
      return c.json({ error: "already connected; Tesla auth is already live" }, 409);
    }
    await deps.auth.exchangeCode(code);
    return c.text("Tesla connected. You can close this tab.");
  });

  // The paste-the-code alternative to the redirect round-trip above, for the GitHub
  // Pages setup path (docs/FREETESSIE_SETUP.md step 7b) where the callback redirect has
  // nowhere to land. No OAuth state to check — the owner proves themselves with the
  // local API key instead (bearer-gated by the middleware, see BEARER_ONLY_PATHS) — and
  // the same already-connected guard as login/callback above still applies.
  app.post("/auth/tesla/code", async (c) => {
    if (await alreadyConnected(deps)) {
      return c.json({ error: "already connected; Tesla auth is already live" }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code : "";
    if (!code) return c.text("missing code", 400);
    await deps.auth.exchangeCode(code);
    return c.text("Tesla connected. You can close this tab.");
  });

  app.get("/vehicles", async (c) => {
    // Tessie's GET /vehicles (https://developer.tessie.com/reference/get-all-vehicles)
    // returns {results:[{vin, is_active, last_state:{...}}]} — Fleet API's own
    // /api/1/vehicles (what deps.fleet.vehicles() forwards) is a completely different,
    // flatter native shape. freetessie has exactly one car, so this is always a
    // one-element wrapper rather than a real re-shape of whatever Fleet returned.
    // last_state comes from whatever's cached (never a billable call just to list
    // vehicles) — same shape /:vin/state would hand back, degraded to all-undefined
    // fields if nothing has been cached yet.
    try {
      await deps.fleet.vehicles();
      const cached = deps.cache.get();
      const last_state = toTessieState(cached?.data ?? {}, readResolvedAddress(deps.db));
      return c.json({
        results: [{ vin: deps.config.vin, is_active: true, last_state }],
      });
    } catch (err) {
      if (err instanceof DeadTokenError) return c.json(DEAD_TOKEN_BODY, 503);
      throw err;
    }
  });

  app.get("/:vin/state", (c) => snapshotRoute(c, deps, (s) => toTessieState(s.data, s.address)));
  app.get("/:vin/battery", (c) => snapshotRoute(c, deps, (s) => toTessieBattery(s.data)));
  app.get("/:vin/location", (c) => snapshotRoute(c, deps, (s) => toTessieLocation(s.data, s.address)));

  app.get("/:vin/status", async (c) => {
    // Cache-only, always — a status check must never itself trigger a billable read.
    const snap = await getSnapshot(deps, false);
    // Tessie's GET /status (https://developer.tessie.com/reference/get-status) returns
    // exactly {"status": "asleep"|"waiting_for_sleep"|"awake"} — map Fleet's own
    // online/asleep/offline onto that enum rather than inventing state/since/connected.
    // "offline" (no telemetry heard from in a while) is the closest Fleet concept to
    // Tessie's "waiting_for_sleep" (car hasn't gone fully to sleep but isn't responding).
    const raw = snap?.data.state;
    const status = raw === "online" ? "awake" : raw === "asleep" ? "asleep" : "waiting_for_sleep";
    return c.json({ status });
  });

  // History goes out in Tessie's own snake_case wire shape so Tessie-built clients read it.
  app.get("/:vin/drives", (c) => {
    const { from, to } = rangeParams(c);
    return c.json(deps.history.drives(from, to).map(toTessieDriveWire));
  });
  app.get("/:vin/charges", (c) => {
    const { from, to } = rangeParams(c);
    return c.json(deps.history.charges(from, to).map(toTessieChargeWire));
  });
  app.get("/:vin/idles", (c) => {
    const { from, to } = rangeParams(c);
    return c.json(deps.history.idles(from, to).map(toTessieIdleWire));
  });

  app.post("/:vin/wake", (c) => runCommand(c, deps, "wake"));
  app.post("/:vin/command/:name", (c) => runCommand(c, deps, c.req.param("name")));

  let server: ServerType | undefined;

  return {
    app,
    start(port = 0): Promise<{ port: number; url: string }> {
      return new Promise((resolve) => {
        server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
          resolve({ port: info.port, url: `http://127.0.0.1:${info.port}` });
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}
