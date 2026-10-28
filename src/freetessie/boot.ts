// boot: wires every real freetessie module into one running server, plus the two
// entry points that need more than contracts.ts's locked FreeTessieConfig shape —
// env loading (which also carries dbPath/port, boot-only concerns that don't belong
// in the Fleet-API-facing config contract) and the fake-Fleet boot path tests and
// FAKE_FLEET=1 dev runs use instead of a real Tesla account.
//
// This file owns no vehicle-command logic of its own — it only constructs the real
// fleetAuth/fleetClient/apiKeys/history/stateCache/server modules from contracts.ts
// and hands back the running pieces. Same hard rule as every other freetessie file:
// nothing here is, or routes to, anything Autopilot/FSD/Summon/speed/drive-shaped.

import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { createApiKeyStore } from "./apiKeys.ts";
import { planCommand } from "./commandMap.ts";
import {
  type ApiKeyStore,
  type FleetAuth,
  type FleetClient,
  type FreeTessieConfig,
  type FreeTessieDeps,
  type FreeTessieServer,
  type LoginTokenStore,
  type Region,
} from "./contracts.ts";
import { createFakeFleetServer, type FakeFleetServer } from "./fakeFleetServer.ts";
import { createFleetAuth } from "./fleetAuth.ts";
import { createFleetClient } from "./fleetClient.ts";
import { createHistoryRecorder } from "./history.ts";
import { createLoginTokenStore } from "./loginTokens.ts";
import { createFreeTessieServer } from "./server.ts";
import { createStateCache } from "./stateCache.ts";
import { createTokenStore } from "./tokenStore.ts";

const DEFAULT_SIGNING_PROXY_URL = "https://127.0.0.1:4443";
const DEFAULT_DB_PATH = "freetessie.db";
const DEFAULT_PORT = 4000;

function requireEnvVar(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function parseRegion(raw: string | undefined): Region {
  if (raw === undefined || raw === "na") return "na";
  if (raw === "eu") return "eu";
  throw new Error(`TESLA_REGION must be "na" or "eu", got "${raw}"`);
}

// dbPath/port are boot-sequence concerns (which SQLite file to open, which port to
// listen on) — contracts.ts's FreeTessieConfig deliberately has neither, since every
// other module only ever needs the Fleet-API-facing fields. Bundling them here rather
// than widening the locked contract for two fields only index.ts/this file read.
export interface FreeTessieBootConfig {
  config: FreeTessieConfig;
  dbPath: string;
  port: number;
}

export function loadFreeTessieConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FreeTessieBootConfig {
  const domain = requireEnvVar(env, "TESLA_PUBLIC_KEY_DOMAIN");
  const publicKeyPath = env.TESLA_PUBLIC_KEY_PATH;

  return {
    config: {
      clientId: requireEnvVar(env, "TESLA_CLIENT_ID"),
      clientSecret: requireEnvVar(env, "TESLA_CLIENT_SECRET"),
      vin: requireEnvVar(env, "TESLA_VIN"),
      region: parseRegion(env.TESLA_REGION),
      publicKeyDomain: domain,
      redirectUri: env.TESLA_OAUTH_REDIRECT_URI ?? `https://${domain}/auth/tesla/callback`,
      publicKeyPem: publicKeyPath && existsSync(publicKeyPath) ? readFileSync(publicKeyPath, "utf8") : null,
      signingProxyUrl: env.TESLA_SIGNING_PROXY_URL ?? DEFAULT_SIGNING_PROXY_URL,
      // Test/dev overrides only — a real boot leaves these undefined and fleetAuth.ts/
      // fleetClient.ts fall back to FLEET_HOSTS/FLEET_AUTH_HOST.
      fleetBaseUrl: env.FLEET_BASE_URL,
      authBaseUrl: env.FLEET_AUTH_URL,
    },
    dbPath: env.FREETESSIE_DB_PATH ?? DEFAULT_DB_PATH,
    port: Number(env.FREETESSIE_PORT ?? DEFAULT_PORT),
  };
}

export interface FreeTessie {
  server: FreeTessieServer;
  deps: FreeTessieDeps;
  apiKeys: ApiKeyStore;
  loginTokens: LoginTokenStore;
  auth: FleetAuth;
  fleet: FleetClient;
}

// Wires every real module together against one DatabaseSync. Each module ensures its
// own tables lazily (same idiom as src/agent/memory.ts) — nothing here runs a migration.
export function createFreeTessie(config: FreeTessieConfig, db: DatabaseSync): FreeTessie {
  const tokenStore = createTokenStore(db);
  const auth = createFleetAuth({ config, store: tokenStore });
  const apiKeys = createApiKeyStore(db);
  const loginTokens = createLoginTokenStore(db);
  const fleet = createFleetClient({
    config,
    getAccessToken: () => auth.validAccessToken(),
    getPartnerToken: () => auth.partnerToken(),
  });
  const deps: FreeTessieDeps = {
    config,
    db,
    auth,
    fleet,
    apiKeys,
    loginTokens,
    history: createHistoryRecorder(db),
    cache: createStateCache(db),
    planCommand,
  };
  const server = createFreeTessieServer(deps);
  return { server, deps, apiKeys, loginTokens, auth, fleet };
}

export interface FakeFleetBoot {
  config: FreeTessieConfig;
  fake: FakeFleetServer;
  stop(): Promise<void>;
}

// FAKE_FLEET=1 and scripts/e2e.ts's FLEET scenario both need a config pointing at an
// in-memory Fleet API + signing-proxy stand-in with NO human OAuth step — real setup's
// steps 2/5/7/8 in docs/FREETESSIE_SETUP.md (register the app, pick a domain, consent,
// tap the pairing link) have no equivalent here, so tokens are seeded straight through
// the fake server's own token endpoint instead. The caller's `db` is the SAME db that
// createFreeTessie(config, db) will be built against, so the seeded row is already
// there when FleetAuth reads it — there is no second db to keep in sync.
export async function bootFakeFleet(db: DatabaseSync, vin = "TEST000000000VIN"): Promise<FakeFleetBoot> {
  const fake = createFakeFleetServer(vin);
  const { url } = await fake.start();

  const config: FreeTessieConfig = {
    clientId: "fake-client",
    clientSecret: "fake-secret",
    vin,
    region: "na",
    publicKeyDomain: "freetessie.invalid",
    redirectUri: "https://freetessie.invalid/auth/tesla/callback",
    publicKeyPem: null,
    signingProxyUrl: url,
    fleetBaseUrl: url,
    authBaseUrl: url,
  };

  // Same exchangeCode("<anything>") seeding path server.test.ts uses — the fake token
  // endpoint's authorization_code grant never validates the code, so any string mints
  // a real (fake) access/refresh pair and persists it via the real tokenStore/save().
  const seedAuth = createFleetAuth({ config, store: createTokenStore(db) });
  await seedAuth.exchangeCode("seed-code");

  return {
    config,
    fake,
    async stop(): Promise<void> {
      await fake.stop();
    },
  };
}
