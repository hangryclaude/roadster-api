// freetessie — the locked contract between its modules.
//
// freetessie is a self-hosted Tessie replacement: it speaks Tesla's official Fleet API
// (the owner's own developer app = the API key) and re-exposes the Tessie-shaped REST
// surface that src/tesla/tessieAdapter.ts already calls, so the texting agent needs no
// new adapter — only TESSIE_BASE_URL/TESSIE_TOKEN change. Design: docs/FREETESSIE-BRIEF.md.
//
// Every module imports its types and constants from here and implements exactly these
// signatures. Do not add, rename, or widen an exported symbol without updating every
// implementer — the parallel builders rely on this file being stable.
//
// Same hard rule as src/tesla/adapter.ts: nothing here, and nothing behind it, touches
// Autopilot/FSD/Summon/speed/driving, and nothing is jailbreak/root/firmware. The command
// vocabulary below is closed: exactly the 21 Tessie command names TessieAdapter sends.

import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Tesla hosts and fixed paths (docs/FREETESSIE-RESEARCH.md, fleet-auth angle)
// ---------------------------------------------------------------------------

export type Region = "na" | "eu";

export const FLEET_HOSTS: Record<Region, string> = {
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
};

// Token endpoint moved off auth.tesla.com in 2025 ("unexpected issuer" on the old host).
// The /authorize page itself still lives on auth.tesla.com.
export const FLEET_AUTH_HOST = "https://fleet-auth.prd.vn.cloud.tesla.com";
export const TESLA_AUTHORIZE_URL = "https://auth.tesla.com/oauth2/v3/authorize";
export const TOKEN_PATH = "/oauth2/v3/token";

export const PUBLIC_KEY_PATH = "/.well-known/appspecific/com.tesla.3p.public-key.pem";
export const pairingLink = (domain: string): string => `https://tesla.com/_ak/${domain}`;

// vehicle_location is its own scope since 2024 — omitting it returns no lat/long.
export const OWNER_SCOPES = [
  "openid",
  "offline_access",
  "vehicle_device_data",
  "vehicle_location",
  "vehicle_cmds",
  "vehicle_charging_cmds",
] as const;

// vehicle_data only includes lat/long when location_data is explicitly requested.
export const VEHICLE_DATA_ENDPOINTS = [
  "charge_state",
  "climate_state",
  "drive_state",
  "location_data",
  "vehicle_state",
] as const;

// ---------------------------------------------------------------------------
// Config (src/index.ts and scripts build this from env; tests build it by hand)
// ---------------------------------------------------------------------------

export interface FreeTessieConfig {
  clientId: string;
  clientSecret: string;
  vin: string;
  region: Region;
  /** domain that serves PUBLIC_KEY_PATH and appears in the tesla.com/_ak pairing link */
  publicKeyDomain: string;
  /** OAuth callback, e.g. https://<domain>/auth/tesla/callback — must be an allowed redirect URI on the app */
  redirectUri: string;
  /** PEM text to serve at PUBLIC_KEY_PATH from this process; null when another host serves it */
  publicKeyPem: string | null;
  /** tesla-http-proxy (Go sidecar) base URL, e.g. https://127.0.0.1:4443 */
  signingProxyUrl: string;
  /** test override for Tesla's Fleet API host (the fake server) */
  fleetBaseUrl?: string;
  /** test override for the token endpoint host (the fake server) */
  authBaseUrl?: string;
  /** reverse geocoder; default implementation uses Nominatim, tests inject a stub */
  geocode?: (lat: number, lon: number) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Owner OAuth tokens — SQLite table fleet_tokens, single row (one owner, one car)
// ---------------------------------------------------------------------------

export interface OwnerTokens {
  accessToken: string;
  refreshToken: string;
  /** unix ms */
  expiresAt: number;
  scope: string;
  /** set when a refresh answered login_required (e.g. the owner changed their Tesla password) */
  dead: boolean;
}

export interface TokenStore {
  load(): OwnerTokens | null;
  /** replaces the single row atomically; the NEW refresh token must be durable before use */
  save(tokens: OwnerTokens): void;
  markDead(): void;
}

export class DeadTokenError extends Error {
  constructor(message = "Tesla auth is dead — the owner must re-authorize") {
    super(message);
    this.name = "DeadTokenError";
  }
}

export interface FleetAuth {
  /** owner consent URL (authorization code flow, OWNER_SCOPES, state echoed back) */
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<OwnerTokens>;
  /** throws DeadTokenError on login_required; persists the rotated refresh token before returning */
  refresh(current: OwnerTokens): Promise<OwnerTokens>;
  /** client_credentials token for partner endpoints only; never persisted */
  partnerToken(): Promise<string>;
  /** load → refresh if < 5 min left → return a usable access token; throws DeadTokenError */
  validAccessToken(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Fleet API data shapes (subset read; Tesla's own field names, same as Tessie mirrors)
// ---------------------------------------------------------------------------

export interface FleetVehicleData {
  state?: string; // "online" | "asleep" | "offline"
  vehicle_state?: {
    odometer?: number;
    locked?: boolean;
    sentry_mode?: boolean;
    charge_port_door_open?: boolean;
    timestamp?: number;
  };
  charge_state?: {
    battery_level?: number;
    charge_limit_soc?: number;
    charging_state?: string;
    charge_energy_added?: number;
    timestamp?: number;
  };
  climate_state?: {
    is_climate_on?: boolean;
    inside_temp?: number; // Celsius
    driver_temp_setting?: number; // Celsius
    timestamp?: number;
  };
  drive_state?: {
    latitude?: number;
    longitude?: number;
    shift_state?: string | null; // "D" | "R" | "N" | "P" | null
    speed?: number | null;
    timestamp?: number;
  };
}

// The closed vocabulary of signed vehicle commands freetessie will ever send.
export type FleetCommandName =
  | "door_lock"
  | "door_unlock"
  | "auto_conditioning_start"
  | "auto_conditioning_stop"
  | "set_temps"
  | "charge_start"
  | "charge_stop"
  | "set_charge_limit"
  | "charge_port_door_open"
  | "charge_port_door_close"
  | "actuate_trunk"
  | "honk_horn"
  | "flash_lights"
  | "set_sentry_mode"
  | "window_control"
  | "set_scheduled_departure";

export class CommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly reason: string,
  ) {
    super(`Fleet command ${command} failed: ${reason}`);
    this.name = "CommandError";
  }
}

export class UnknownCommandError extends Error {
  constructor(name: string) {
    super(`unknown Tessie command "${name}" — not in freetessie's closed vocabulary`);
    this.name = "UnknownCommandError";
  }
}

// Every Tesla-facing call is counted so tests can assert the cost invariant
// (e.g. "this scenario made 1 wake, 2 commands, 1 live read, 0 polls").
export interface FleetCallCounts {
  vehicleData: number;
  wake: number;
  command: number;
  navigation: number;
  fleetStatus: number;
}

export interface FleetClient {
  readonly counts: FleetCallCounts;
  vehicles(): Promise<unknown>;
  /** live, billable read; requests VEHICLE_DATA_ENDPOINTS */
  vehicleData(): Promise<FleetVehicleData>;
  /** billable; polls until state === "online" or throws after timeoutMs (default 60s) */
  wake(timeoutMs?: number): Promise<void>;
  fleetStatus(): Promise<{ online: boolean; keyPaired: boolean | null; raw: unknown }>;
  /** goes through the signing sidecar; throws CommandError when result:false */
  signedCommand(name: FleetCommandName, body?: Record<string, unknown>): Promise<void>;
  /** navigation_request is carved out of the signed protocol — plain bearer, direct to Fleet API */
  navigationRequest(address: string): Promise<void>;
  /** one-time POST /api/1/partner_accounts with a partner token */
  registerPartner(domain: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tessie command names → Fleet calls (src/freetessie/commandMap.ts)
// ---------------------------------------------------------------------------

export const TESSIE_COMMANDS = [
  "wake",
  "start_climate",
  "stop_climate",
  "set_temperatures",
  "lock",
  "unlock",
  "start_charging",
  "stop_charging",
  "set_charge_limit",
  "open_charge_port",
  "close_charge_port",
  "activate_rear_trunk",
  "activate_front_trunk",
  "honk",
  "flash",
  "enable_sentry",
  "disable_sentry",
  "vent_windows",
  "close_windows",
  "share",
  "schedule_departure",
] as const;
export type TessieCommandName = (typeof TESSIE_COMMANDS)[number];

export type CommandPlan =
  | { kind: "wake" }
  | { kind: "signed"; name: FleetCommandName; body?: Record<string, unknown> }
  | { kind: "navigation"; address: string };

/** Tessie query params (all strings) → the Fleet call to make. Throws UnknownCommandError. */
export type PlanCommand = (tessieName: string, query: Record<string, string>) => CommandPlan;

// ---------------------------------------------------------------------------
// State cache + history (src/freetessie/history.ts) — pure state machine, no I/O
// ---------------------------------------------------------------------------

export interface DriveRow {
  id: number;
  startedAt: number;
  endedAt: number | null;
  startOdometer: number;
  endOdometer: number | null;
  startBattery: number;
  endBattery: number | null;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
}

export interface ChargeRow {
  id: number;
  startedAt: number;
  endedAt: number | null;
  startBattery: number;
  endBattery: number | null;
  energyAddedKwh: number | null;
  lat: number | null;
  lon: number | null;
}

export interface IdleRow {
  id: number;
  startedAt: number;
  endedAt: number | null;
  startBattery: number;
  endBattery: number | null;
}

export interface HistoryRecorder {
  /** feed every observed vehicle_data snapshot (live read or telemetry); opens/closes sessions */
  observe(data: FleetVehicleData, atMs: number): void;
  drives(fromMs?: number, toMs?: number): DriveRow[];
  charges(fromMs?: number, toMs?: number): ChargeRow[];
  idles(fromMs?: number, toMs?: number): IdleRow[];
}

export interface StateCache {
  get(): { data: FleetVehicleData; fetchedAt: number } | null;
  put(data: FleetVehicleData, fetchedAt: number): void;
}

// ---------------------------------------------------------------------------
// Local API keys (src/freetessie/apiKeys.ts) — the "Tessie token" the owner mints
// ---------------------------------------------------------------------------

export interface ApiKeyRecord {
  id: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface ApiKeyStore {
  /** returns the plaintext exactly once; only its hash is stored */
  mint(label: string): { id: string; token: string };
  /** constant-time compare against stored hashes; false for revoked/unknown */
  verify(token: string): boolean;
  revoke(id: string): void;
  list(): ApiKeyRecord[];
}

// ---------------------------------------------------------------------------
// One-time login links (src/freetessie/loginTokens.ts) — the owner-only guard on the
// OAuth bootstrap. Without it, anyone who finds the public domain could complete THEIR
// Tesla login against this server before the owner does and own the single token row.
// ---------------------------------------------------------------------------

export interface LoginTokenStore {
  /** plaintext returned once; stored hashed; expires after 15 minutes */
  mint(): string;
  /** true exactly once per valid, unexpired token; false for unknown/used/expired */
  consume(token: string): boolean;
}

// ---------------------------------------------------------------------------
// Server (src/freetessie/server.ts) — the Tessie-compatible surface
// ---------------------------------------------------------------------------

export interface FreeTessieDeps {
  config: FreeTessieConfig;
  db: DatabaseSync;
  auth: FleetAuth;
  fleet: FleetClient;
  apiKeys: ApiKeyStore;
  loginTokens: LoginTokenStore;
  history: HistoryRecorder;
  cache: StateCache;
  planCommand: PlanCommand;
}

export interface FreeTessieServer {
  app: Hono;
  start(port?: number): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
}

// Route table the server must implement (Tessie paths; bearer = a minted local API key):
//   GET  /{vin}/state                 cached snapshot (never a Tesla call); 404 if cache empty
//   GET  /{vin}/state?use_cache=false live vehicle_data (billable); updates cache + history
//   GET  /{vin}/battery, /{vin}/location, /{vin}/status
//   GET  /{vin}/drives, /{vin}/charges, /{vin}/idles   (?from=&to= unix SECONDS, Tessie's
//        convention; replies use Tessie's snake_case wire shape from history.ts)
//   GET  /vehicles
//   POST /{vin}/wake  and  POST /{vin}/command/wake    (TessieAdapter sends the latter)
//   POST /{vin}/command/{name}?...     via planCommand; reply {result:true} or {result:false, reason}
//        vent_windows/close_windows: the server injects lat/lon from the cached vehicle
//        location (one live read if the cache is empty) before planCommand — Tesla's
//        window_control is proximity-gated; close is refused when no location is known.
//   POST /auth/tesla/code {code}       bearer-gated paste-the-code fallback → exchangeCode
// Unauthenticated:
//   GET  /health
//   GET  /.well-known/appspecific/com.tesla.3p.public-key.pem   (only if config.publicKeyPem)
//   GET  /auth/tesla/login?t=<one-time token from LoginTokenStore.mint()>  302 to
//        auth.authorizeUrl(state); 403 without a valid t; 409 when already connected
//   GET  /auth/tesla/callback?code=&state=   exchangeCode → TokenStore.save → plain-text "connected"
// Rules: no route may schedule or loop Tesla calls; every state reply is Tessie-shaped
// (vehicle_state/charge_state/climate_state/drive_state + address) so tessieAdapter.ts
// normalizeState() parses it unchanged.
