// freetessie-setup: one idempotent CLI covering every scriptable step in
// docs/FREETESSIE_SETUP.md — keygen/register/pair are one-time, login-url/mint-key/status
// are safe to re-run any time. Each subcommand prints the next human step rather than
// assuming the operator already knows the full flow, matching that doc's step order.
//
// Usage: npm run freetessie:setup -- <keygen|register|login-url|pair|mint-key|status>

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { createApiKeyStore } from "../src/freetessie/apiKeys.ts";
import { createFreeTessie, loadFreeTessieConfigFromEnv } from "../src/freetessie/boot.ts";
import { pairingLink, PUBLIC_KEY_PATH } from "../src/freetessie/contracts.ts";
import { createLoginTokenStore } from "../src/freetessie/loginTokens.ts";

const KEYS_DIR = "keys";

function usage(): never {
  console.error("usage: freetessie-setup <keygen|register|login-url|pair|mint-key|status>");
  process.exit(1);
}

// mint-key and status's cached-state check only ever need FREETESSIE_DB_PATH — routing
// them through loadFreeTessieConfigFromEnv (which requires TESLA_CLIENT_ID/SECRET/etc)
// would force an operator rotating a local key to also have Tesla creds on hand for no
// reason. register/login-url/pair genuinely need the full config, so they use the loader.
function dbPathFromEnv(): string {
  return process.env.FREETESSIE_DB_PATH ?? "freetessie.db";
}

function keygen(): void {
  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR);
  const privatePath = `${KEYS_DIR}/private-key.pem`;
  const publicPath = `${KEYS_DIR}/public-key.pem`;

  if (existsSync(privatePath) || existsSync(publicPath)) {
    console.log(
      `freetessie-setup: ${privatePath} / ${publicPath} already exist — not overwriting. ` +
        "Delete both first if you really want a new keypair (re-pairing the virtual key would then be required too).",
    );
  } else {
    // secp256r1 == prime256v1 — the curve Tesla's virtual-key doc requires. Encoding
    // options requested directly so this returns PEM strings, not KeyObjects to export.
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "sec1", format: "pem" },
    });
    writeFileSync(privatePath, privateKey);
    chmodSync(privatePath, 0o600); // never world/group readable — this signs vehicle commands
    writeFileSync(publicPath, publicKey);
    console.log(`freetessie-setup: wrote ${privatePath} (mode 600) and ${publicPath}`);
  }

  const domain = process.env.TESLA_PUBLIC_KEY_DOMAIN;
  if (domain) {
    console.log(`Next [YOU]: host ${publicPath}'s contents at exactly this URL, no redirect:`);
    console.log(`  https://${domain}${PUBLIC_KEY_PATH}`);
  } else {
    console.log(
      `Next [YOU]: set TESLA_PUBLIC_KEY_DOMAIN, then host ${publicPath}'s contents at ` +
        `https://<that domain>${PUBLIC_KEY_PATH}`,
    );
  }
}

async function register(): Promise<void> {
  const { config, dbPath } = loadFreeTessieConfigFromEnv();
  const db = new DatabaseSync(dbPath);
  try {
    const freetessie = createFreeTessie(config, db);
    const result = await freetessie.fleet.registerPartner(config.publicKeyDomain);
    console.log("freetessie-setup: POST /api/1/partner_accounts response:", JSON.stringify(result));
    console.log("Next: run `npm run freetessie:setup -- login-url` and open the printed URL.");
  } finally {
    db.close();
  }
}

function loginUrl(): void {
  const { config, port } = loadFreeTessieConfigFromEnv();
  // The one-time login token has to land in the SAME SQLite file the running server
  // reads, because /auth/tesla/login consumes it from there (loginTokens.ts) — the link
  // is the owner-only guard on the OAuth bootstrap, so it is never printed without one.
  const db = new DatabaseSync(dbPathFromEnv());
  try {
    const t = createLoginTokenStore(db).mint();
    const origin = config.redirectUri.replace(/\/auth\/tesla\/callback$/, "");
    console.log(`One-time login link (valid 15 minutes):       ${origin}/auth/tesla/login?t=${t}`);
    console.log(`Same link via loopback if the tunnel is down:  http://127.0.0.1:${port}/auth/tesla/login?t=${t}`);
    console.log("Next [YOU]: open it with freetessie running; it sends you to Tesla — log into YOUR OWN Tesla account and approve the scopes.");
  } finally {
    db.close();
  }
}

function pair(): void {
  const { config } = loadFreeTessieConfigFromEnv();
  console.log(`Pairing link: ${pairingLink(config.publicKeyDomain)}`);
  console.log(
    "Next [YOU, physical]: open that link FROM THE TESLA APP ON YOUR PHONE (version >= 4.27.3), " +
      "with the car ONLINE, then tap Approve. Nothing can do this step but you — Tesla requires a " +
      "human tap from the vehicle's own owner inside its own app.",
  );
}

function mintKey(): void {
  const db = new DatabaseSync(dbPathFromEnv());
  try {
    const { token } = createApiKeyStore(db).mint("freetessie-setup mint-key");
    console.log(`freetessie-setup: minted a new local API key (shown once): ${token}`);
    console.log("Next: put this in your .env as FREETESSIE_LOCAL_KEY (or leave it unset to auto-mint at every boot).");
  } finally {
    db.close();
  }
}

async function status(): Promise<void> {
  const { config, dbPath } = loadFreeTessieConfigFromEnv();
  const db = new DatabaseSync(dbPath);
  try {
    const freetessie = createFreeTessie(config, db);

    let tokensAlive = true;
    try {
      await freetessie.auth.validAccessToken();
    } catch {
      tokensAlive = false;
    }
    console.log(`Tokens alive: ${tokensAlive ? "yes" : "no — run \`login-url\`, then open it and connect"}`);

    if (tokensAlive) {
      try {
        const fleetStatus = await freetessie.fleet.fleetStatus();
        const paired = fleetStatus.keyPaired === null ? "unknown (no primary source for this field — see boot report)" : fleetStatus.keyPaired;
        console.log(`Virtual key paired: ${paired}`);
      } catch (err) {
        console.log(`Virtual key paired: could not check (${(err as Error).message})`);
      }
    } else {
      console.log("Virtual key paired: skipped — no live tokens to check with");
    }

    const cached = freetessie.deps.cache.get();
    console.log(
      cached
        ? `Cached state age: ${Math.round((Date.now() - cached.fetchedAt) / 1000)}s`
        : "Cached state age: no cached state yet (nothing has read live state since this DB was created)",
    );
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  switch (cmd) {
    case "keygen":
      return keygen();
    case "register":
      return register();
    case "login-url":
      return loginUrl();
    case "pair":
      return pair();
    case "mint-key":
      return mintKey();
    case "status":
      return status();
    default:
      usage();
  }
}

main().catch((err) => {
  console.error("freetessie-setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
