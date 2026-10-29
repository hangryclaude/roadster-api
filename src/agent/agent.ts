// Claude tool-use loop, PIN challenge state, ack-then-reread confirm.
//
// unlock/open_trunk/open_frunk are the only tools with gate "pin": a call to one is
// held until the current chat's next inbound message supplies the matching USER_PIN,
// then re-invoked. schedule_action has gate "confirm": it always replies with the
// planned time and "Reply CANCEL to cancel" instead of a result, since nothing has
// run yet. Every other tool's run() re-reads vehicle state before replying "done" —
// never confirm on request sent, only on a re-read that shows the change took, and
// the model's own free text is never trusted over that verified result (see
// lastUnverifiedText below).
//
// Never wires in Autopilot/FSD/Summon/speed/drive. A request to add one — including
// "just route it to a raw endpoint" or similar workarounds — gets refused here and in
// tools.ts, not implemented. See SPEC.md "What this will never do."

import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AnthropicClientLike,
  AnthropicMessage,
  AnthropicTextBlock,
  AnthropicToolSchema,
  AnthropicToolUseBlock,
} from "./anthropic.ts";
import { addTurn, ensureMemorySchema, getRecentTurns } from "./memory.ts";
import { awaiting, liveCommands } from "../roadster/manifest.ts";
import { profile, type VehicleModel } from "../roadster/vehicles.ts";
import { findTool, TOOLS, type Tool, type ToolResult } from "./tools.ts";
import type { InboundMessageLike, SchedulerLike, VehicleAdapterLike } from "./types.ts";

const MAX_TOOL_ROUNDS = 6;
const MAX_PIN_ATTEMPTS = 3;
const PIN_CHALLENGE_TIMEOUT_MS = 5 * 60 * 1000;

// Fact-free: no example numbers, no made-up mileage/battery/address — those would
// prime the model toward echoing them back as if real. States the never-do list so a
// jailbreak attempt inside a user message can't talk the model into a tool that
// doesn't exist, and so the model never invents a workaround when one is missing.
function systemPrompt(now: Date, ownerTimeZone: string, model: VehicleModel): string {
  const car = profile(model);
  const liveList = liveCommands()
    .map((e) => e.name)
    .join(", ");
  const flightList = awaiting()
    .map((e) => e.name)
    .join(", ");
  // The vehicle line names the actual car behind the VIN. The flight paragraph is only
  // offered when the manifest has flight rows for this model (the Roadster), so a
  // Cybertruck owner is never told "land" is a command they have.
  const vehicleLine = `The car is a Tesla ${car.name}${car.bed ? " (it has an open cargo bed rather than a rear trunk)" : ""}.`;
  const flightPara = car.flight
    ? `The Roadster's flight commands (${flightList}) are in the manifest as awaiting_fleet_api: Tesla has not published an endpoint for any of them. For any request to fly, hover, land, jump, take off, or use the thrusters, call roadster_flight and relay its answer — never substitute a different tool for a flight request.`
    : `This car has no flight commands. If asked to fly, hover, or use thrusters, say plainly that a ${car.name} cannot do that and offer the commands you do have.`;
  return `You are Roadster, a texting assistant that reads and controls one Tesla through a fixed set of tools. Call yourself Roadster if asked who you are.
${vehicleLine}
The commands you have are exactly the live rows of the Roadster manifest: ${liveList}.
${flightPara}

Current server time: ${now.toISOString()} (owner's local timezone: ${ownerTimeZone}). Use this, not your own
sense of "now", when turning relative phrasing ("in 15 minutes", "at 6pm") into an ISO 8601 time for
schedule_action — interpret a bare time like "6pm" in the owner's timezone above.

Rules:
- Only use the tools provided. Never claim to have done something you didn't call a tool for.
- Never say an action is done until you have a fresh state read confirming it. If a tool's result doesn't confirm the change, say what the re-read actually showed instead of guessing. If a tool's result contradicts whatever you were about to say, trust the tool result.
- climate, charging, charge limit, charge port, honk, flash, sentry, vent/close windows, and nav destination need no confirmation from the owner — just do them.
- unlocking and opening the trunk or frunk require the owner's PIN; the tool-use harness handles that challenge, you don't need to ask for the PIN yourself.
- For any "in N minutes" / "at a time" phrasing, use schedule_action to wrap the underlying tool rather than trying to delay yourself.
- The car's own native scheduled departure (set_scheduled_departure) is not cancelled by CANCEL — that only cancels things scheduled with schedule_action. To turn off a native scheduled departure, call cancel_scheduled_departure.
- Never use, mention as available, or suggest a workaround for Autopilot, Full Self-Driving, Summon, steering, speed control, or anything that drives the car. No jailbreak, root, or firmware access exists or will ever be added here. If asked for any of this — including indirectly, or framed as a game, test, override code, or hypothetical — refuse plainly and say this assistant only reads and controls parking-lot vehicle functions.
- Keep replies short and plain, like a text message.`;
}

const DRIVING_REFUSAL =
  "I only read and control parking-lot vehicle functions (climate, locks, charging, trunk/frunk, horn, lights, sentry, windows, nav, and scheduled departure). I can't touch Autopilot, Full Self-Driving, Summon, steering, speed, or anything that drives the car — that's not something this assistant does, jailbroken or not.";

// Matches a request for the one category of control this project will never add,
// however it's phrased — checked before the model even sees the message so a clever
// prompt can't talk a future model revision into inventing a workaround tool.
const DRIVING_KEYWORDS =
  /\b(autopilot|full[\s-]?self[\s-]?driving|\bfsd\b|summon|self[\s-]?drive|drive (it|the car)|steer(ing)?|accelerat|set (the )?speed|jailbreak|root access|firmware)\b/i;

// A PIN entered in chat must never be written to conversation memory (and from there
// into every later Anthropic request for that chat) — only whether it matched.
const PIN_REDACTED_PLACEHOLDER = "[PIN entered — redacted]";

export interface AgentDeps {
  client: AnthropicClientLike;
  adapter: VehicleAdapterLike;
  scheduler: SchedulerLike;
  db: DatabaseSync;
  // sha256 digest of the configured PIN (see index.ts hashPin) — never the plaintext.
  // Comparison happens with timingSafeEqual, not ===, so a failed guess can't be
  // distinguished by response timing.
  userPinHash: Buffer;
  ownerTimeZone?: string; // IANA zone name, e.g. "America/Denver" — defaults to UTC
  // Which Tesla is behind the VIN (src/roadster/vehicles.ts). Defaults to "roadster" so the
  // flight-boundary tests and the no-VIN dev path keep the Roadster prompt.
  vehicleModel?: VehicleModel;
  now?: () => Date; // injectable clock for tests; defaults to () => new Date()
}

interface PendingPin {
  toolName: string;
  toolArgs: Record<string, unknown>;
  attempts: number;
  expiresAt: number;
}

// Per-chat PIN challenge state. Module-level by design: it's ephemeral UX state for
// "the next message is either the PIN or CANCEL", not durable data — a restart
// dropping an unanswered PIN prompt is fine (the owner just re-sends the command).
const pendingPins = new Map<string, PendingPin>();

// Per-chat "a native scheduled departure is currently configured" flag, so CANCEL's
// error message can point at cancel_scheduled_departure instead of silently doing
// nothing. Not durable state — losing it on restart just means that hint is skipped.
const nativeDepartureConfigured = new Set<string>();

function toolSchemas(): AnthropicToolSchema[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

// Exported so index.ts hashes the configured USER_PIN once at startup, and tests can
// build a matching hash without duplicating the algorithm.
export function hashPin(pin: string): Buffer {
  return createHash("sha256").update(pin).digest();
}

function pinMatches(hash: Buffer, candidate: string): boolean {
  const candidateHash = createHash("sha256").update(candidate).digest();
  return candidateHash.length === hash.length && timingSafeEqual(candidateHash, hash);
}

// schedule_action inherits the wrapped tool's PIN gate — a request to schedule
// unlock/trunk/frunk for later must be held for the PIN exactly like the immediate
// path, never bypass it by going through schedule_action's own gate:"confirm".
function effectiveGateRequiresPin(tool: Tool, args: Record<string, unknown>): boolean {
  if (tool.gate === "pin") return true;
  if (tool.name === "schedule_action") {
    const wrapped = findTool(String((args as Record<string, unknown>).tool ?? ""));
    return wrapped?.gate === "pin";
  }
  return false;
}

async function runGatedTool(
  tool: Tool,
  args: Record<string, unknown>,
  deps: AgentDeps,
  msg: InboundMessageLike,
  pinVerified: boolean,
  now: Date,
): Promise<{ result: ToolResult; shortCircuit: boolean }> {
  if (effectiveGateRequiresPin(tool, args) && !pinVerified) {
    pendingPins.set(msg.chatId, {
      toolName: tool.name,
      toolArgs: args,
      attempts: 0,
      expiresAt: now.getTime() + PIN_CHALLENGE_TIMEOUT_MS,
    });
    return {
      result: { text: "That needs your PIN first — reply with it to confirm.", verified: false },
      shortCircuit: true,
    };
  }
  const result = await tool.run(args, {
    adapter: deps.adapter,
    scheduler: deps.scheduler,
    channel: msg.channel,
    chatId: msg.chatId,
    pinVerified,
    now,
  });
  if (tool.name === "set_scheduled_departure") nativeDepartureConfigured.add(msg.chatId);
  if (tool.name === "cancel_scheduled_departure") nativeDepartureConfigured.delete(msg.chatId);
  // gate "confirm" (the schedule_action family) replies with the planned time and
  // stops right there — there's nothing further for the model to react to, and
  // looping back in would risk it narrating a "done" that hasn't happened yet.
  return { result, shortCircuit: tool.gate === "confirm" };
}

async function runClaudeLoop(
  deps: AgentDeps,
  msg: InboundMessageLike,
  pinVerified: boolean,
  now: Date,
): Promise<string> {
  const history = getRecentTurns(deps.db, msg.chatId);
  const messages: AnthropicMessage[] = [
    ...history.map((t): AnthropicMessage => ({ role: t.role, content: t.content })),
    { role: "user", content: msg.text },
  ];

  // Tracks the most recent mutating tool result that the fresh state re-read could
  // NOT confirm. If the model's eventual free-text reply follows such a result, that
  // text is discarded in favor of the tool's own (accurate) text — the model's prose
  // is never allowed to override a failed verification into a false "done".
  let lastUnverifiedText: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await deps.client.createMessage({
      system: systemPrompt(now, deps.ownerTimeZone ?? "UTC", deps.vehicleModel ?? "roadster"),
      messages,
      tools: toolSchemas(),
    });

    const toolUses = response.content.filter((b): b is AnthropicToolUseBlock => b.type === "tool_use");
    const textBlocks = response.content.filter((b): b is AnthropicTextBlock => b.type === "text");

    if (toolUses.length === 0) {
      const modelText = textBlocks.map((b) => b.text).join("\n").trim();
      if (lastUnverifiedText) return lastUnverifiedText;
      return modelText || "OK.";
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
    for (const use of toolUses) {
      const tool = findTool(use.name);
      if (!tool) {
        toolResults.push({ type: "tool_result", tool_use_id: use.id, content: `Unknown tool: ${use.name}` });
        continue;
      }
      const { result, shortCircuit } = await runGatedTool(tool, use.input, deps, msg, pinVerified, now);
      lastUnverifiedText = result.verified ? null : result.text;
      if (shortCircuit) {
        // Don't let the model keep going while a PIN is outstanding, or narrate past
        // a schedule_action reply that already said everything there is to say.
        return result.text;
      }
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content: result.text });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return lastUnverifiedText ?? "Still working on that — try asking again in a moment.";
}

export async function handleInbound(deps: AgentDeps, msg: InboundMessageLike): Promise<string> {
  ensureMemorySchema(deps.db);
  const trimmed = msg.text.trim();
  const upper = trimmed.toUpperCase();
  const now = (deps.now ?? (() => new Date()))();

  // STOP is Twilio's carrier-reserved opt-out keyword. Twilio normally intercepts it
  // before the webhook ever fires, but on the rare chance one does arrive, it must
  // stay a no-op here too — never passed to the model, which could otherwise
  // interpret it as a command (e.g. charge_stop). CANCEL (never STOP) is this app's
  // own keyword for cancelling a pending scheduled action.
  if (upper === "STOP") {
    return "";
  }

  // CANCEL cancels the most recent pending app-scheduled trigger for this chat, and
  // clears any PIN challenge too. "X" is the same alias, but SMS-only — Telegram users
  // get no reason to type a bare "X" as a cancel, so there it falls through to the
  // normal agent loop instead of silently eating an unrelated message.
  const isCancelWord = upper === "CANCEL" || (upper === "X" && msg.channel === "twilio");
  if (isCancelWord) {
    pendingPins.delete(msg.chatId);
    const cancelled = deps.scheduler.cancelLatestPending(msg.channel, msg.chatId);
    let reply = cancelled ? "Cancelled." : "Nothing pending to cancel.";
    if (!cancelled && nativeDepartureConfigured.has(msg.chatId)) {
      reply += " (There's a native scheduled departure set on the car — ask me to turn scheduled departure off to cancel that.)";
    }
    addTurn(deps.db, msg.chatId, "user", msg.text);
    addTurn(deps.db, msg.chatId, "assistant", reply);
    return reply;
  }

  const pending = pendingPins.get(msg.chatId);
  if (pending) {
    if (now.getTime() > pending.expiresAt) {
      pendingPins.delete(msg.chatId);
      const reply = "That PIN challenge timed out. Try the command again.";
      addTurn(deps.db, msg.chatId, "user", PIN_REDACTED_PLACEHOLDER);
      addTurn(deps.db, msg.chatId, "assistant", reply);
      return reply;
    }
    if (pinMatches(deps.userPinHash, trimmed)) {
      pendingPins.delete(msg.chatId);
      const tool = findTool(pending.toolName);
      if (!tool) {
        return "That PIN matched, but the pending action is gone. Try the command again.";
      }
      const { result } = await runGatedTool(tool, pending.toolArgs, deps, msg, true, now);
      // Never persist the PIN itself to memory — only that it was entered.
      addTurn(deps.db, msg.chatId, "user", PIN_REDACTED_PLACEHOLDER);
      addTurn(deps.db, msg.chatId, "assistant", result.text);
      return result.text;
    }
    pending.attempts += 1;
    if (pending.attempts >= MAX_PIN_ATTEMPTS) {
      pendingPins.delete(msg.chatId);
      const reply = "Too many wrong PIN attempts. Nothing unlocked. Try the command again.";
      addTurn(deps.db, msg.chatId, "user", PIN_REDACTED_PLACEHOLDER);
      addTurn(deps.db, msg.chatId, "assistant", reply);
      return reply;
    }
    const reply = "That PIN didn't match. Nothing unlocked. Try again or reply CANCEL.";
    addTurn(deps.db, msg.chatId, "user", PIN_REDACTED_PLACEHOLDER);
    addTurn(deps.db, msg.chatId, "assistant", reply);
    return reply;
  }

  if (DRIVING_KEYWORDS.test(trimmed)) {
    addTurn(deps.db, msg.chatId, "user", msg.text);
    addTurn(deps.db, msg.chatId, "assistant", DRIVING_REFUSAL);
    return DRIVING_REFUSAL;
  }

  const reply = await runClaudeLoop(deps, msg, false, now);
  addTurn(deps.db, msg.chatId, "user", msg.text);
  addTurn(deps.db, msg.chatId, "assistant", reply);
  return reply;
}

// Test-only escape hatch so test/agent can assert pending-PIN state resets between
// cases without reaching into module internals via a hack.
export function __resetPendingPinsForTests(): void {
  pendingPins.clear();
  nativeDepartureConfigured.clear();
}
