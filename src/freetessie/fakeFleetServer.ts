// FakeFleetServer: in-memory stand-in for Tesla's Fleet API host AND the tesla-http-proxy
// signing sidecar, on one Hono app — fleetClient.ts's tests (and scripts/e2e.ts) point both
// config.fleetBaseUrl/config.authBaseUrl and config.signingProxyUrl at this same server, since
// there is no interface mismatch to absorb (the real proxy uses the exact same REST shape
// Fleet API itself uses, per docs/FREETESSIE-BRIEF.md's signing-sidecar decision).
//
// Deliberately has no route for anything Autopilot/FSD/Summon/speed/drive-adjacent — see
// SPEC.md "What this will never do." A command name matching that shape 404s before it
// ever reaches the closed FleetCommandName vocabulary check below.

import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import type { FleetCommandName } from "./contracts.ts";

export type TokenMode = "ok" | "login_required" | "flaky";

export interface FakeFleetVehicleData {
  state: "online" | "asleep";
  vehicle_state: {
    odometer: number;
    locked: boolean;
    sentry_mode: boolean;
    charge_port_door_open: boolean;
    timestamp: number;
  };
  charge_state: {
    battery_level: number;
    charge_limit_soc: number;
    charging_state: "Charging" | "Stopped" | "Complete" | "Disconnected";
    charge_energy_added: number;
    timestamp: number;
  };
  climate_state: {
    is_climate_on: boolean;
    inside_temp: number;
    driver_temp_setting: number;
    timestamp: number;
  };
  drive_state: {
    latitude: number;
    longitude: number;
    shift_state: string | null;
    speed: number | null;
    timestamp: number;
  };
}

function defaultState(): FakeFleetVehicleData {
  const now = Date.now();
  return {
    state: "asleep",
    vehicle_state: {
      odometer: 47382,
      locked: true,
      sentry_mode: false,
      charge_port_door_open: false,
      timestamp: now,
    },
    charge_state: {
      battery_level: 54,
      charge_limit_soc: 90,
      charging_state: "Stopped",
      charge_energy_added: 0,
      timestamp: now,
    },
    climate_state: { is_climate_on: false, inside_temp: 18, driver_temp_setting: 20, timestamp: now },
    drive_state: { latitude: 39.7392, longitude: -104.9903, shift_state: null, speed: null, timestamp: now },
  };
}

export interface FakeFleetCounts {
  vehicleData: number;
  wake: number;
  command: number;
  navigation: number;
  fleetStatus: number;
  token: number;
}

// The 16-name closed vocabulary fleetClient.ts's signedCommand ever sends — anything outside
// this set gets the 403 "Tesla Vehicle Command Protocol required" body, exactly like a real
// vehicle the proxy doesn't recognize and has to forward on to Fleet API itself.
const KNOWN_COMMANDS: ReadonlySet<string> = new Set<FleetCommandName>([
  "door_lock",
  "door_unlock",
  "auto_conditioning_start",
  "auto_conditioning_stop",
  "set_temps",
  "charge_start",
  "charge_stop",
  "set_charge_limit",
  "charge_port_door_open",
  "charge_port_door_close",
  "actuate_trunk",
  "honk_horn",
  "flash_lights",
  "set_sentry_mode",
  "window_control",
  "set_scheduled_departure",
]);

// Hard-blocked at the route level, ahead of the closed-vocabulary check above, so a probe
// for e.g. "autopilot_request" can never be mistaken for "outside FleetCommandName" and
// get the softer 403 — it 404s, because the route genuinely does not exist.
const FORBIDDEN_NAME_PATTERN = /autopilot|summon|fsd|^drive|^speed/i;

const PROTOCOL_REQUIRED_BODY = {
  error:
    "Tesla Vehicle Command Protocol required, please refer to the documentation here: " +
    "https://developer.tesla.com/docs/fleet-api/announcements" +
    "#2023-10-09-rest-api-vehicle-commands-endpoint-deprecation-warning",
  error_description: "",
};

export interface FakeFleetServer {
  /** mutable so tests can assert on it or seed a scenario directly */
  state: FakeFleetVehicleData;
  /** every Tesla-facing route hit, by call type — mirrors FleetCallCounts plus token calls */
  counts: FakeFleetCounts;
  /** when false, every signed command responds {response:{result:false,reason:"virtual key missing"}} */
  keyPaired: boolean;
  /** when set, the next command hitting this name responds with result:false instead of true */
  failNextCommand: FleetCommandName | null;
  /** wake_up reports state:"online" starting from this many wake_up calls (1 = wakes immediately) */
  wakeAfterCalls: number;
  tokenMode: TokenMode;
  /** every navigation_request body received, in order */
  navigationRequestsReceived: unknown[];
  /** every signed command received, in order, with its parsed JSON body */
  commandsReceived: Array<{ name: string; body: Record<string, unknown> }>;
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
}

export function createFakeFleetServer(vin = "TEST000000000VIN"): FakeFleetServer {
  const state = defaultState();
  const counts: FakeFleetCounts = {
    vehicleData: 0,
    wake: 0,
    command: 0,
    navigation: 0,
    fleetStatus: 0,
    token: 0,
  };
  const knobs = {
    keyPaired: true,
    failNextCommand: null as FleetCommandName | null,
    wakeAfterCalls: 1,
    tokenMode: "ok" as TokenMode,
  };
  const navigationRequestsReceived: unknown[] = [];
  const commandsReceived: Array<{ name: string; body: Record<string, unknown> }> = [];
  let wakeCallCount = 0;
  // Rotating refresh tokens with a one-generation grace window, matching the brief's §3
  // OAuth design note (the superseded token stays valid briefly, not forever).
  let currentRefreshToken = "test-refresh-token";
  let previousRefreshToken: string | null = null;
  let server: ServerType | undefined;

  const app = new Hono();

  function newToken(prefix: string): string {
    return `${prefix}-${randomBytes(8).toString("hex")}`;
  }

  // ---------------------------------------------------------------------
  // Token endpoint — client_credentials (partner), authorization_code and
  // refresh_token (owner) grants, all on one path per the real Fleet-auth host.
  // ---------------------------------------------------------------------
  app.post("/oauth2/v3/token", async (c) => {
    counts.token++;
    const body = await c.req.parseBody();
    const grantType = String(body.grant_type ?? "");

    if (knobs.tokenMode === "login_required") {
      // Simulates a Tesla-account password change: every refresh dies instantly, no
      // workaround — confirmed by teslamotors/vehicle-command#132, cited in the brief.
      return c.json({ error: "login_required", error_description: "re-authenticate" }, 401);
    }
    if (knobs.tokenMode === "flaky" && Math.random() < 0.5) {
      return c.json({ error: "server_error", error_description: "" }, 500);
    }

    if (grantType === "client_credentials") {
      return c.json({
        access_token: newToken("partner"),
        token_type: "Bearer",
        expires_in: 28800,
      });
    }
    if (grantType === "authorization_code") {
      previousRefreshToken = null;
      currentRefreshToken = newToken("refresh");
      return c.json({
        access_token: newToken("owner"),
        refresh_token: currentRefreshToken,
        expires_in: 28800,
        token_type: "Bearer",
        scope: "openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds",
      });
    }
    if (grantType === "refresh_token") {
      const presented = String(body.refresh_token ?? "");
      if (presented !== currentRefreshToken && presented !== previousRefreshToken) {
        return c.json({ error: "invalid_grant", error_description: "" }, 401);
      }
      previousRefreshToken = currentRefreshToken;
      currentRefreshToken = newToken("refresh");
      return c.json({
        access_token: newToken("owner"),
        refresh_token: currentRefreshToken,
        expires_in: 28800,
        token_type: "Bearer",
        scope: "openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds",
      });
    }
    return c.json({ error: "unsupported_grant_type", error_description: "" }, 400);
  });

  // ---------------------------------------------------------------------
  // Partner registration
  // ---------------------------------------------------------------------
  app.post("/api/1/partner_accounts", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    if (!auth.startsWith("Bearer partner-")) {
      return c.json({ error: "invalid_token", error_description: "" }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    return c.json({ response: { domain: (body as { domain?: unknown })?.domain ?? null } });
  });

  // ---------------------------------------------------------------------
  // Vehicle list / lightweight vehicle info / vehicle_data / wake_up / fleet_status
  // ---------------------------------------------------------------------
  app.get("/api/1/vehicles", (c) => {
    return c.json({
      response: [{ id: 1, vehicle_id: 1, vin, display_name: "Test Vehicle", state: state.state }],
      count: 1,
    });
  });

  // Lightweight, non-billable vehicle summary — what wake() polls instead of vehicle_data.
  app.get(`/api/1/vehicles/${vin}`, (c) => {
    return c.json({ response: { id: 1, vin, state: state.state } });
  });

  app.get(`/api/1/vehicles/${vin}/vehicle_data`, (c) => {
    counts.vehicleData++;
    const endpointsParam = c.req.query("endpoints") ?? "";
    const endpoints = endpointsParam.split(";").filter(Boolean);
    const snapshot: Record<string, unknown> = {
      state: state.state,
      vehicle_state: state.vehicle_state,
      charge_state: state.charge_state,
      climate_state: state.climate_state,
    };
    // Lat/long only come back when location_data is explicitly requested — confirmed by
    // the docs' "vehicle_location is its own scope" note (contracts.ts OWNER_SCOPES).
    if (endpoints.includes("location_data")) {
      snapshot.drive_state = state.drive_state;
    }
    return c.json({ response: snapshot });
  });

  app.post(`/api/1/vehicles/${vin}/wake_up`, (c) => {
    counts.wake++;
    wakeCallCount++;
    if (wakeCallCount >= knobs.wakeAfterCalls) state.state = "online";
    return c.json({ response: { id: 1, vin, state: state.state } });
  });

  app.post("/api/1/vehicles/fleet_status", async (c) => {
    counts.fleetStatus++;
    const body = await c.req.json().catch(() => ({}));
    const vins = Array.isArray((body as { vins?: unknown })?.vins)
      ? ((body as { vins: unknown[] }).vins.filter((v) => typeof v === "string") as string[])
      : [];
    const keyPairedVins = knobs.keyPaired ? vins.filter((v) => v === vin) : [];
    const unpairedVins = vins.filter((v) => !keyPairedVins.includes(v));
    return c.json({
      response: {
        key_paired_vins: keyPairedVins,
        unpaired_vins: unpairedVins,
        vehicle_info: {
          [vin]: { firmware_version: "2026.4.1", vehicle_command_protocol_required: false },
        },
      },
    });
  });

  // ---------------------------------------------------------------------
  // navigation_request — unsigned, plain-bearer carve-out. Registered as its own exact
  // path ahead of the generic :name command route below so it never falls into the
  // closed-vocabulary 403 check.
  // ---------------------------------------------------------------------
  app.post(`/api/1/vehicles/${vin}/command/navigation_request`, async (c) => {
    counts.navigation++;
    const body = await c.req.json().catch(() => ({}));
    navigationRequestsReceived.push(body);
    return c.json({ response: { result: true, reason: "" } });
  });

  // ---------------------------------------------------------------------
  // Signed commands — the tesla-http-proxy-shaped surface.
  // ---------------------------------------------------------------------
  function mutateCommandState(name: string, body: Record<string, unknown>): void {
    switch (name) {
      case "door_lock":
        state.vehicle_state.locked = true;
        break;
      case "door_unlock":
        state.vehicle_state.locked = false;
        break;
      case "auto_conditioning_start":
        state.climate_state.is_climate_on = true;
        break;
      case "auto_conditioning_stop":
        state.climate_state.is_climate_on = false;
        break;
      case "set_temps": {
        const driverTemp = Number(body.driver_temp);
        if (!Number.isNaN(driverTemp)) state.climate_state.driver_temp_setting = driverTemp;
        break;
      }
      case "charge_start":
        state.charge_state.charging_state = "Charging";
        break;
      case "charge_stop":
        state.charge_state.charging_state = "Stopped";
        break;
      case "set_charge_limit": {
        const percent = Number(body.percent);
        if (!Number.isNaN(percent)) state.charge_state.charge_limit_soc = percent;
        break;
      }
      case "charge_port_door_open":
        state.vehicle_state.charge_port_door_open = true;
        break;
      case "charge_port_door_close":
        state.vehicle_state.charge_port_door_open = false;
        break;
      case "set_sentry_mode":
        if (typeof body.on === "boolean") state.vehicle_state.sentry_mode = body.on;
        break;
      // actuate_trunk, honk_horn, flash_lights, window_control, set_scheduled_departure
      // have no field in FleetVehicleData to persist, same as fakeTessieServer.ts's own
      // commands with no modeled state — they still count and can still fail/succeed.
      default:
        break;
    }
  }

  app.post(`/api/1/vehicles/${vin}/command/:name`, async (c) => {
    const name = c.req.param("name");

    if (FORBIDDEN_NAME_PATTERN.test(name)) {
      return c.json({ error: "not_found", error_description: "" }, 404);
    }
    if (!KNOWN_COMMANDS.has(name)) {
      return c.json(PROTOCOL_REQUIRED_BODY, 403);
    }

    counts.command++;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    commandsReceived.push({ name, body });

    if (knobs.failNextCommand === name) {
      knobs.failNextCommand = null;
      return c.json({ response: { result: false, reason: "virtual key missing" } });
    }
    if (!knobs.keyPaired) {
      return c.json({ response: { result: false, reason: "virtual key missing" } });
    }

    mutateCommandState(name, body);
    return c.json({ response: { result: true, reason: "" } });
  });

  return {
    state,
    counts,
    navigationRequestsReceived,
    commandsReceived,
    get keyPaired() {
      return knobs.keyPaired;
    },
    set keyPaired(v: boolean) {
      knobs.keyPaired = v;
    },
    get failNextCommand() {
      return knobs.failNextCommand;
    },
    set failNextCommand(v: FleetCommandName | null) {
      knobs.failNextCommand = v;
    },
    get wakeAfterCalls() {
      return knobs.wakeAfterCalls;
    },
    set wakeAfterCalls(v: number) {
      knobs.wakeAfterCalls = v;
    },
    get tokenMode() {
      return knobs.tokenMode;
    },
    set tokenMode(v: TokenMode) {
      knobs.tokenMode = v;
    },
    start(): Promise<{ port: number; url: string }> {
      return new Promise((resolve) => {
        server = serve({ fetch: app.fetch, port: 0 }, (info) => {
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
