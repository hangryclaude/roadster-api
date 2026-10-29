// env load, DB open, adapter pick, channels wire-up, boot.
// See ARCHITECTURE.md "Env / boot sequence" for the full 8-step sequence this fills in.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import Anthropic from "@anthropic-ai/sdk";

import { migrate } from "../scripts/migrate.ts";
import { TessieAdapter } from "./tesla/tessieAdapter.ts";
import { createFakeTessieServer } from "./tesla/fakeTessieServer.ts";
import type { VehicleAdapter } from "./tesla/adapter.ts";
import { bootFakeFleet, createFreeTessie, loadFreeTessieConfigFromEnv, type FreeTessie } from "./freetessie/boot.ts";
import { TelegramChannel } from "./channels/telegram.ts";
import { TwilioChannel } from "./channels/twilio.ts";
import type { Channel, InboundMessage } from "./channels/channel.ts";
import { handleInbound, hashPin, type AgentDeps } from "./agent/agent.ts";
import { modelFromVin } from "./roadster/vehicles.ts";
import { scheduleTrigger, cancelLatestPending, type Trigger } from "./scheduler/triggers.ts";
import { startPoller } from "./scheduler/poller.ts";
import type { AnthropicClientLike, AnthropicCreateParams, AnthropicResponse } from "./agent/anthropic.ts";
import type { SchedulerLike, ScheduleRequest } from "./agent/types.ts";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function parseAllowedChatIds(): Set<string> {
  return new Set(
    (process.env.ALLOWED_CHAT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// Adapts the real Anthropic SDK client to agent.ts's minimal AnthropicClientLike
// interface — agent.ts never imports @anthropic-ai/sdk directly so its tests can
// inject a fake client without pulling the real SDK's types in.
function adaptAnthropicClient(apiKey: string): AnthropicClientLike {
  const client = new Anthropic({ apiKey });
  return {
    async createMessage(params: AnthropicCreateParams): Promise<AnthropicResponse> {
      const res = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system: params.system,
        messages: params.messages as Anthropic.MessageParam[],
        tools: params.tools as Anthropic.Tool[],
      });
      return res as unknown as AnthropicResponse;
    },
  };
}

function schedulerFor(db: DatabaseSync): SchedulerLike {
  return {
    schedule(req: ScheduleRequest) {
      return scheduleTrigger(db, req as Omit<Trigger, "id" | "status" | "createdAt" | "pinVerified">);
    },
    cancelLatestPending(channel, chatId) {
      return cancelLatestPending(db, channel as Trigger["channel"], chatId);
    },
  };
}

async function main(): Promise<void> {
  // 1. Load env. Fail fast on a missing var the channels actually being started need
  // — ANTHROPIC_API_KEY and USER_PIN are always required; TELEGRAM_BOT_TOKEN/TWILIO_*
  // are only required for the channel that's actually configured.
  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  // Hashed immediately — the plaintext PIN is never held onto past this line, and
  // every later comparison goes through agent.ts's timingSafeEqual check.
  const userPinHash = hashPin(requireEnv("USER_PIN"));
  const ownerTimeZone = process.env.OWNER_TIMEZONE ?? "UTC";
  const allowedChatIds = parseAllowedChatIds();
  const port = Number(process.env.PORT ?? 3000);
  const fakeTessie = process.env.FAKE_TESSIE === "1";
  const fleetMode = process.env.FLEET_MODE === "1";

  // 2. Open/create the SQLite DB, run the triggers-table migration (agent_memory's
  // own schema is ensured lazily by agent.ts/memory.ts on first inbound message).
  const dbPath = process.env.DB_PATH ?? "backseat-tesla.db";
  const db = new DatabaseSync(dbPath);
  migrate(db);

  // 3. Construct the adapter. Three backends, same TessieAdapter class every time —
  // freetessie's whole point is that TessieAdapter needs no code changes, only a
  // different baseUrl/token:
  //   - FLEET_MODE=1: boot freetessie in-process (its own SQLite file, its own
  //     loopback port) and point TessieAdapter at 127.0.0.1:<freetessiePort>.
  //     FAKE_FLEET=1 backs that freetessie instance with bootFakeFleet's in-memory
  //     Fleet API stand-in instead of a real Tesla account (used by scripts/e2e.ts
  //     and local dev without Tesla developer credentials).
  //   - FAKE_TESSIE=1 (no FLEET_MODE): the existing FakeTessieServer path, unchanged.
  //   - neither: the real api.tessie.com, unchanged.
  let adapter: VehicleAdapter;
  // The VIN picks the vehicle profile the agent is told about (Cybertruck, Model Y, ...).
  let vin = "";
  let fakeServerStop: (() => Promise<void>) | undefined;
  let freetessie: FreeTessie | undefined;
  let freetessieDb: DatabaseSync | undefined;
  let freetessieStop: (() => Promise<void>) | undefined;

  if (fleetMode) {
    const { config: envConfig, dbPath: freetessieDbPath, port: freetessiePort } = process.env.FAKE_FLEET === "1"
      ? { config: undefined, dbPath: process.env.FREETESSIE_DB_PATH ?? "freetessie.db", port: Number(process.env.FREETESSIE_PORT ?? 4000) }
      : loadFreeTessieConfigFromEnv();

    freetessieDb = new DatabaseSync(freetessieDbPath);

    let fakeFleetStop: (() => Promise<void>) | undefined;
    const config = envConfig ?? (await (async () => {
      const booted = await bootFakeFleet(freetessieDb!);
      fakeFleetStop = booted.stop;
      return booted.config;
    })());

    freetessie = createFreeTessie(config, freetessieDb);
    const { port: boundPort } = await freetessie.server.start(freetessiePort);

    // Local key: FREETESSIE_LOCAL_KEY means "this was already minted once via
    // `npm run freetessie:setup -- mint-key` and its hash is already sitting in
    // freetessieDbPath" — read it straight from env rather than re-minting (minting
    // again would print a second key whose hash this one's own hash would never
    // match). Absent, mint fresh and print it ONCE — only the sha256 hash is ever
    // persisted (apiKeys.ts), so this stderr line is the only place the plaintext
    // exists after this process starts.
    let localKey = process.env.FREETESSIE_LOCAL_KEY;
    if (!localKey) {
      const minted = freetessie.apiKeys.mint("backseat-tesla local client");
      localKey = minted.token;
      console.error(
        `freetessie: minted a local API key (shown once, store it as FREETESSIE_LOCAL_KEY): ${localKey}`,
      );
    }

    vin = config.vin;
    adapter = new TessieAdapter(localKey, vin, `http://127.0.0.1:${boundPort}`);
    freetessieStop = async (): Promise<void> => {
      await freetessie!.server.stop();
      if (fakeFleetStop) await fakeFleetStop();
      freetessieDb!.close();
    };
  } else if (fakeTessie) {
    const fake = createFakeTessieServer();
    const { url } = await fake.start();
    vin = "TEST000000000VIN";
    adapter = new TessieAdapter("fake-token", vin, url);
    fakeServerStop = fake.stop;
  } else {
    vin = requireEnv("TESSIE_VIN");
    adapter = new TessieAdapter(requireEnv("TESSIE_TOKEN"), vin);
  }

  const client = adaptAnthropicClient(anthropicApiKey);
  const scheduler = schedulerFor(db);
  // An unrecognised VIN (the fake server's, or a future scheme) keeps the Roadster prompt.
  const decoded = modelFromVin(vin);
  const vehicleModel = decoded === "unknown" ? "roadster" : decoded;
  const deps: AgentDeps = { client, adapter, scheduler, db, userPinHash, ownerTimeZone, vehicleModel };

  // 4. Construct channels present in env, wire each one's onMessage to
  // handleInbound -> Channel.send.
  const channels = new Map<Trigger["channel"], Channel>();
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    const telegram = new TelegramChannel(telegramToken, allowedChatIds);
    wireChannel(telegram, deps);
    channels.set("telegram", telegram);
  }
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  let twilio: TwilioChannel | undefined;
  if (twilioSid) {
    twilio = new TwilioChannel(
      twilioSid,
      requireEnv("TWILIO_AUTH_TOKEN"),
      requireEnv("TWILIO_FROM_NUMBER"),
      allowedChatIds,
      process.env.PUBLIC_BASE_URL,
    );
    wireChannel(twilio, deps);
    channels.set("twilio", twilio);
  }

  // 5. Mount Hono routes: health check, Twilio webhook.
  const app = new Hono();
  app.get("/health", (c) => c.text("ok"));
  if (twilio) {
    app.post("/twilio/sms", (c) => twilio!.handleWebhook(c.req.raw));
  }

  // 6. Start configured channels (Telegram opens long polling; Twilio is a no-op,
  // webhook-driven).
  for (const channel of channels.values()) {
    await channel.start();
  }

  // 7. Start the scheduler poller, keeping its stop() handle for graceful shutdown.
  const poller = startPoller({ db, adapter, channels });

  const shutdown = async (): Promise<void> => {
    poller.stop();
    for (const channel of channels.values()) {
      await channel.stop();
    }
    if (fakeServerStop) await fakeServerStop();
    if (freetessieStop) await freetessieStop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 8. Listen. Twilio's webhook needs this reachable (ngrok/tunnel or a real deploy
  // target) — out of scope for this module.
  serve({ fetch: app.fetch, port });
}

function wireChannel(channel: Channel, deps: AgentDeps): void {
  channel.onMessage(async (msg: InboundMessage) => {
    const reply = await handleInbound(deps, msg);
    await channel.send(msg.chatId, reply);
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
