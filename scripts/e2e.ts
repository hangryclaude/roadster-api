// e2e: boots the real agent + scheduler + an in-process channel against two
// vehicle-backend scenarios — no real Tessie token, no real Tesla developer app, no
// real Anthropic API key, no real Telegram/Twilio. Proves the wiring in
// src/index.ts's boot sequence actually works end to end for both:
//
// TESSIE scenario (src/tesla/fakeTessieServer.ts, TessieAdapter talking to it directly):
//   - "warm up my car in 1 minute" -> schedule_action(climate_on) -> poller fires it
//     -> climate turns on on the fake vehicle -> confirmation sent back on the
//     originating channel, built from a fresh re-read (runThenVerify), not on
//     request-sent.
//   - "how many miles" -> get_vehicle_state -> reply built from a fresh read.
//   - "is it locked" -> get_vehicle_state -> reply reflects the fake vehicle's
//     actual locked state.
//
// FLEET scenario (bootFakeFleet + createFreeTessie, TessieAdapter talking to THAT
// instead of the fake Tessie server): proves the whole freetessie stack end to end —
// "lock it" -> commandMap -> a SIGNED command through the fake Fleet/signing-proxy
// stand-in -> the fake vehicle's locked flag flips -> "how many miles" reply is built
// from a fresh vehicle_data read (fleet.counts.vehicleData goes up), and the vehicle
// being already online the whole time means zero wake_up calls happen.
//
// Exits 1 (after closing every handle) if any assertion fails, so CI / npm run e2e
// has a real pass/fail signal.

import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

import { migrate } from "./migrate.ts";
import { createFakeTessieServer } from "../src/tesla/fakeTessieServer.ts";
import { TessieAdapter } from "../src/tesla/tessieAdapter.ts";
import { bootFakeFleet, createFreeTessie } from "../src/freetessie/boot.ts";
import { handleInbound, hashPin, type AgentDeps } from "../src/agent/agent.ts";
import { scheduleTrigger, cancelLatestPending, type Trigger } from "../src/scheduler/triggers.ts";
import { startPoller, runThenVerify } from "../src/scheduler/poller.ts";
import type {
  AnthropicClientLike,
  AnthropicCreateParams,
  AnthropicResponse,
  AnthropicMessage,
} from "../src/agent/anthropic.ts";
import type { SchedulerLike, ScheduleRequest } from "../src/agent/types.ts";
import type { Channel, InboundMessage } from "../src/channels/channel.ts";

// In-process Channel: no network, no grammY/Twilio — just a send() log the e2e
// script can assert against, same interface real channels implement so wiring this
// in is identical to wiring in TelegramChannel/TwilioChannel.
function createInProcessChannel(kind: "telegram" | "twilio"): Channel & { sent: Array<{ chatId: string; text: string }> } {
  const sent: Array<{ chatId: string; text: string }> = [];
  let handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  return {
    kind,
    sent,
    isAllowed() {
      return true;
    },
    onMessage(h) {
      handler = h;
    },
    async send(chatId, text) {
      sent.push({ chatId, text });
    },
    async start() {},
    async stop() {},
    // test-only helper, not part of the Channel interface
    async __deliver(msg: InboundMessage) {
      if (!handler) throw new Error("no handler wired");
      await handler(msg);
    },
  } as Channel & { sent: Array<{ chatId: string; text: string }>; __deliver(msg: InboundMessage): Promise<void> };
}

function lastUserText(messages: AnthropicMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return null;
  return typeof last.content === "string" ? last.content : null;
}

function hasToolResult(messages: AnthropicMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string") return null;
  const block = last.content.find((b) => b.type === "tool_result");
  return block && block.type === "tool_result" ? block.content : null;
}

// Maps the three fixed phrases this e2e drives to canned tool_use responses, then on
// the follow-up round (once the tool_result comes back) replies with plain text
// built from that result — exactly the shape a real Claude response takes.
function fakeAnthropicClient(nowPlusOneMinuteIso: () => string): AnthropicClientLike {
  return {
    async createMessage(params: AnthropicCreateParams): Promise<AnthropicResponse> {
      const userText = lastUserText(params.messages);
      const toolResult = hasToolResult(params.messages);

      if (toolResult !== null) {
        // Second round: the tool already ran (or, for schedule_action, already
        // replied) — just surface its result text as the final assistant message.
        return { content: [{ type: "text", text: toolResult }], stop_reason: "end_turn" };
      }

      if (userText?.toLowerCase().includes("warm up my car")) {
        return {
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "schedule_action",
              input: { tool: "climate_on", args: {}, whenISO: nowPlusOneMinuteIso() },
            },
          ],
          stop_reason: "tool_use",
        };
      }

      if (userText?.toLowerCase().includes("how many miles") || userText?.toLowerCase().includes("is it locked")) {
        return {
          content: [{ type: "tool_use", id: "call_2", name: "get_vehicle_state", input: {} }],
          stop_reason: "tool_use",
        };
      }

      throw new Error(`fakeAnthropicClient: no scripted response for "${userText}"`);
    },
  };
}

// FLEET scenario's fake client: "lock it" first, then "how many miles" — a lock
// tool_use round added on top of the same toolResult/get_vehicle_state shapes above,
// scripted separately so this scenario's two fixed phrases stay obviously exhaustive
// rather than growing the TESSIE client's branch list.
function fakeFleetAnthropicClient(): AnthropicClientLike {
  return {
    async createMessage(params: AnthropicCreateParams): Promise<AnthropicResponse> {
      const userText = lastUserText(params.messages);
      const toolResult = hasToolResult(params.messages);

      if (toolResult !== null) {
        return { content: [{ type: "text", text: toolResult }], stop_reason: "end_turn" };
      }

      if (userText?.toLowerCase().includes("lock it")) {
        return {
          content: [{ type: "tool_use", id: "call_lock", name: "lock", input: {} }],
          stop_reason: "tool_use",
        };
      }

      if (userText?.toLowerCase().includes("how many miles")) {
        return {
          content: [{ type: "tool_use", id: "call_miles", name: "get_vehicle_state", input: {} }],
          stop_reason: "tool_use",
        };
      }

      throw new Error(`fakeFleetAnthropicClient: no scripted response for "${userText}"`);
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

async function runTessieScenario(): Promise<void> {
  const fake = createFakeTessieServer();
  const { url } = await fake.start();
  const adapter = new TessieAdapter("fake-token", "TEST000000000VIN", url);

  const db = new DatabaseSync(":memory:");
  migrate(db);

  const client = fakeAnthropicClient(() => new Date(Date.now() + 60_000).toISOString());
  const deps: AgentDeps = { client, adapter, scheduler: schedulerFor(db), db, userPinHash: hashPin("0000") };

  const channel = createInProcessChannel("telegram");
  channel.onMessage(async (msg) => {
    const reply = await handleInbound(deps, msg);
    await channel.send(msg.chatId, reply);
  });

  const channels = new Map<Trigger["channel"], Channel>([["telegram", channel]]);
  // Fast poll interval so the e2e doesn't wait 10s for the real default.
  const poller = startPoller({ db, adapter, channels, intervalMs: 50 });

  try {
    // "warm up my car in 1 minute" -> schedule_action -> immediate "Reply CANCEL"
    // reply, nothing fired yet.
    await (channel as unknown as { __deliver(msg: InboundMessage): Promise<void> }).__deliver({
      channel: "telegram",
      chatId: "owner-1",
      text: "warm up my car in 1 minute",
    });
    assert.equal(fake.state.climate_state.is_climate_on, false, "climate must not be on before the trigger fires");
    const scheduleReply = channel.sent.at(-1);
    assert.ok(scheduleReply, "expected an immediate schedule confirmation");
    assert.match(scheduleReply!.text, /CANCEL/, "schedule confirmation must mention Reply CANCEL");

    // Force the trigger due now instead of waiting a real minute, then let the
    // poller's own interval pick it up and fire it (proves the real poll loop, not
    // just a direct dueTriggers() call).
    db.prepare(`UPDATE triggers SET fire_at = ? WHERE status = 'pending'`).run(Date.now());

    await runThenVerify(
      async () => {},
      async () => fake.state.climate_state.is_climate_on,
      (on) => on === true,
      5_000,
    );
    assert.equal(fake.state.climate_state.is_climate_on, true, "fake vehicle's climate must have turned on");
    assert.equal(fake.commandsReceived.includes("start_climate"), true);

    const confirmation = channel.sent.find((m) => /climate is on/i.test(m.text));
    assert.ok(confirmation, "expected the poller to send a climate-on confirmation via the originating channel");

    // "how many miles" -> get_vehicle_state read.
    await (channel as unknown as { __deliver(msg: InboundMessage): Promise<void> }).__deliver({
      channel: "telegram",
      chatId: "owner-1",
      text: "how many miles",
    });
    const milesReply = channel.sent.at(-1);
    assert.match(milesReply!.text, new RegExp(String(fake.state.vehicle_state.odometer)));

    // "is it locked" -> get_vehicle_state read, reflects the fake vehicle's actual
    // locked state (default: locked).
    await (channel as unknown as { __deliver(msg: InboundMessage): Promise<void> }).__deliver({
      channel: "telegram",
      chatId: "owner-1",
      text: "is it locked",
    });
    const lockedReply = channel.sent.at(-1);
    assert.match(lockedReply!.text, /Locked/);

    console.log("e2e: TESSIE scenario passed");
  } finally {
    poller.stop();
    db.close();
    await fake.stop();
  }
}

// FLEET scenario: the same agent/channel wiring, but TessieAdapter now talks to a
// real (locally-wired) freetessie instance backed by bootFakeFleet's in-memory Fleet
// API + signing-proxy stand-in, instead of the fake Tessie server directly. Proves
// commandMap/fleetClient/server.ts actually produce a Tessie-shaped response
// TessieAdapter can parse unchanged, not just that the two fakes agree with each
// other in isolation (server.test.ts already covers that).
async function runFleetScenario(): Promise<void> {
  // freetessie gets its own DB, same as it would as a separate process in FLEET_MODE
  // — the agent-side db (triggers/agent_memory) below is deliberately a different one.
  const freetessieDb = new DatabaseSync(":memory:");
  const booted = await bootFakeFleet(freetessieDb);
  const freetessie = createFreeTessie(booted.config, freetessieDb);
  const { url } = await freetessie.server.start(0);
  const { token } = freetessie.apiKeys.mint("e2e");

  // Explicitly already online before either call — proves a signed command and a
  // vehicle_data read don't themselves trigger a wake, the costliest Fleet API call.
  booted.fake.state.state = "online";

  const adapter = new TessieAdapter(token, booted.config.vin, url);

  const db = new DatabaseSync(":memory:");
  migrate(db);

  const client = fakeFleetAnthropicClient();
  const deps: AgentDeps = { client, adapter, scheduler: schedulerFor(db), db, userPinHash: hashPin("0000") };

  const channel = createInProcessChannel("telegram");
  channel.onMessage(async (msg) => {
    const reply = await handleInbound(deps, msg);
    await channel.send(msg.chatId, reply);
  });

  try {
    const vehicleDataCallsBeforeLock = freetessie.fleet.counts.vehicleData;

    await (channel as unknown as { __deliver(msg: InboundMessage): Promise<void> }).__deliver({
      channel: "telegram",
      chatId: "owner-1",
      text: "lock it",
    });
    assert.equal(booted.fake.state.vehicle_state.locked, true, "fake Fleet vehicle must be locked");
    assert.equal(booted.fake.counts.command, 1, "lock must have gone through exactly one signed command");
    assert.equal(
      freetessie.fleet.counts.vehicleData,
      vehicleDataCallsBeforeLock + 1,
      "lock's reply must be built from a fresh vehicle_data re-read, not request-sent",
    );
    const lockReply = channel.sent.at(-1);
    assert.match(lockReply!.text, /Locked/);

    await (channel as unknown as { __deliver(msg: InboundMessage): Promise<void> }).__deliver({
      channel: "telegram",
      chatId: "owner-1",
      text: "how many miles",
    });
    const milesReply = channel.sent.at(-1);
    assert.match(milesReply!.text, new RegExp(String(booted.fake.state.vehicle_state.odometer)));

    assert.equal(booted.fake.counts.wake, 0, "already-online vehicle must trigger zero wake_up calls");

    console.log("e2e: FLEET scenario passed");
  } finally {
    db.close();
    await freetessie.server.stop();
    await booted.stop();
    freetessieDb.close();
  }
}

async function main(): Promise<void> {
  await runTessieScenario();
  await runFleetScenario();
}

main().catch((err) => {
  console.error("e2e failed:", err);
  process.exitCode = 1;
});
