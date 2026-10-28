// Tool[] definitions, JSON schemas, gate metadata. Each Tool wraps one
// VehicleAdapterLike method (or schedule_action, which wraps any other tool) and
// carries its own gate so agent.ts doesn't hardcode a PIN/confirm check per tool name.
//
// No tool here for Autopilot, FSD, Summon, speed, or drive — not an oversight. If a
// request asks for one, refuse and point back to SPEC.md "What this will never do."
// Do not add a tool here that calls an adapter method outside VehicleAdapterLike, and
// do not find a workaround via raw HTTP or an undocumented endpoint.

import { awaiting, findEntry } from "../roadster/manifest.ts";
import type { SchedulerLike, VehicleAdapterLike } from "./types.ts";

export type ToolGate = "none" | "pin" | "confirm";

export interface ToolContext {
  adapter: VehicleAdapterLike;
  scheduler: SchedulerLike;
  channel: string;
  chatId: string;
  // True once a PIN has actually been verified for THIS call. schedule_action reads
  // this to decide whether it may schedule a pin-gated wrapped tool (see agent.ts's
  // effectiveGateRequiresPin) and to stamp the stored trigger's pinVerified bit.
  pinVerified: boolean;
  // Server's own clock, passed down so "in 15 minutes" scheduling has an authoritative
  // now instead of each tool reaching for Date.now() independently.
  now: Date;
}

export interface ToolResult {
  text: string;
  // False means the action was attempted but a fresh, cache-bypassing state read
  // could not confirm it took — agent.ts must never let model prose override this.
  // True covers both "verified by re-read" and "nothing to verify, nothing failed"
  // (get_vehicle_state, honk/flash, schedule_action's plan-announcement).
  verified: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: object; // JSON schema passed to the Anthropic SDK tool-use call
  gate: ToolGate;
  // For gate "none"/"pin" tools, text is built from a fresh realtime getState() read
  // after the call — never from the request — so "done" is only said once confirmed,
  // and verified=false whenever that re-read contradicts the intended outcome.
  // gate "confirm" tools (schedule_action) reply with the planned time instead, since
  // nothing has happened yet.
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

function fmtLocation(state: { address: string | null; latitude: number; longitude: number }): string {
  return state.address ?? `${state.latitude}, ${state.longitude}`;
}

function fmtLocked(locked: boolean | null): string {
  return locked === true ? "Locked" : locked === false ? "Unlocked" : "lock state unknown";
}

const NO_ARGS: object = { type: "object", properties: {}, required: [] };

// Shared shape for the "call the adapter, then re-read realtime state and check one
// field" pattern every mutating tool below uses, so the verify-then-confirm logic
// lives in one place instead of being retyped nine times.
async function verifyAfter<T>(
  ctx: ToolContext,
  action: () => Promise<void>,
  check: (state: Awaited<ReturnType<VehicleAdapterLike["getState"]>>) => T,
  describe: (checked: T) => { text: string; verified: boolean },
): Promise<ToolResult> {
  await action();
  const state = await ctx.adapter.getState({ realtime: true });
  return describe(check(state));
}

export const TOOLS: Tool[] = [
  {
    name: "get_vehicle_state",
    description: "Read the vehicle's current odometer, battery, charge, lock, climate, and location state.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      const s = await ctx.adapter.getState({ realtime: true });
      return {
        verified: true,
        text:
          `${s.odometerMiles} miles. ${s.batteryPercent}% battery, ${s.chargingState.toLowerCase()}. ` +
          `${fmtLocked(s.locked)}. Climate ${s.climateOn ? "on" : "off"}. ` +
          `At ${fmtLocation(s)}.`,
      };
    },
  },
  {
    name: "climate_on",
    description: "Turn the climate system on.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      return verifyAfter(
        ctx,
        () => ctx.adapter.climateOn(),
        (s) => s,
        (s) => ({
          verified: s.climateOn,
          text: `Climate is ${s.climateOn ? "on" : "still off"}${s.insideTempF != null ? `, cabin ${s.insideTempF}°F` : ""}.`,
        }),
      );
    },
  },
  {
    name: "climate_off",
    description: "Turn the climate system off.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      return verifyAfter(
        ctx,
        () => ctx.adapter.climateOff(),
        (s) => s,
        (s) => ({ verified: !s.climateOn, text: `Climate is ${s.climateOn ? "still on" : "off"}.` }),
      );
    },
  },
  {
    name: "set_climate_temp",
    description: "Set the climate target temperature in Fahrenheit.",
    inputSchema: {
      type: "object",
      properties: { tempF: { type: "number", description: "Target temperature, Fahrenheit" } },
      required: ["tempF"],
    },
    gate: "none",
    async run(args, ctx) {
      const tempF = Number(args.tempF);
      return verifyAfter(
        ctx,
        () => ctx.adapter.setClimateTemp(tempF),
        (s) => s,
        (s) => {
          // climateTargetF is the set-point Tessie reports back, converted from its
          // Celsius storage — allow 1°F of rounding slack rather than demanding exact
          // float equality across that conversion.
          const matched = s.climateTargetF != null && Math.abs(s.climateTargetF - tempF) <= 1;
          return {
            verified: matched,
            text: matched
              ? `Climate target set to ${tempF}°F.`
              : `Sent a ${tempF}°F target, but the re-read shows ${s.climateTargetF ?? "no"} target set.`,
          };
        },
      );
    },
  },
  {
    name: "lock",
    description: "Lock the vehicle.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      return verifyAfter(
        ctx,
        () => ctx.adapter.lock(),
        (s) => s.locked,
        (locked) => ({
          verified: locked === true,
          text: locked === true ? "Locked." : "Lock command sent, but it's not reading locked yet.",
        }),
      );
    },
  },
  {
    name: "unlock",
    description: "Unlock the vehicle. Requires the owner's PIN.",
    inputSchema: NO_ARGS,
    gate: "pin",
    async run(_args, ctx) {
      return verifyAfter(
        ctx,
        () => ctx.adapter.unlock(),
        (s) => s.locked,
        (locked) => ({
          verified: locked === false,
          text: locked === false ? "Unlocked." : "Unlock command sent, but it's still reading locked.",
        }),
      );
    },
  },
  {
    name: "charge_start",
    description: "Start charging.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      return verifyAfter(
        ctx,
        () => ctx.adapter.chargeStart(),
        (s) => s,
        (s) => ({
          verified: s.chargingState === "Charging",
          text: `Charging ${s.chargingState.toLowerCase()}, ${s.batteryPercent}%.`,
        }),
      );
    },
  },
  {
    name: "charge_stop",
    description: "Stop charging.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      return verifyAfter(
        ctx,
        () => ctx.adapter.chargeStop(),
        (s) => s,
        (s) => ({
          verified: s.chargingState !== "Charging",
          text: `Charging ${s.chargingState.toLowerCase()}.`,
        }),
      );
    },
  },
  {
    name: "set_charge_limit",
    description: "Set the charge limit percentage.",
    inputSchema: {
      type: "object",
      properties: { percent: { type: "number", description: "Charge limit, 0-100" } },
      required: ["percent"],
    },
    gate: "none",
    async run(args, ctx) {
      const percent = Number(args.percent);
      return verifyAfter(
        ctx,
        () => ctx.adapter.setChargeLimit(percent),
        (s) => s,
        (s) => ({
          verified: s.chargeLimitPercent === percent,
          text: `Charge limit set to ${s.chargeLimitPercent}%. Currently at ${s.batteryPercent}%, ${s.chargingState.toLowerCase()}.`,
        }),
      );
    },
  },
  {
    name: "open_charge_port",
    description: "Open the charge port door.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      return verifyAfter(
        ctx,
        () => ctx.adapter.openChargePort(),
        (s) => s.chargePortOpen,
        (open) => ({
          verified: open === true,
          text: open === true ? "Charge port opened." : "Charge port command sent, but it's not reading open yet.",
        }),
      );
    },
  },
  {
    name: "close_charge_port",
    description: "Close the charge port door.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      return verifyAfter(
        ctx,
        () => ctx.adapter.closeChargePort(),
        (s) => s.chargePortOpen,
        (open) => ({
          verified: open === false,
          text: open === false ? "Charge port closed." : "Charge port close sent, but it's not reading closed yet.",
        }),
      );
    },
  },
  {
    // Tesla/Tessie don't expose a trunk-open telemetry field — it's a momentary
    // latch actuator, not a reportable state — so there is nothing to re-read here.
    // The honest fix for "never say done before a state read" when no such state
    // exists is to not claim "opened": the adapter already throws if Tessie's
    // result:false says the command itself failed, so a resolved call means
    // "accepted", not "confirmed open" — the wording below says exactly that.
    name: "open_trunk",
    description: "Open the rear trunk. Requires the owner's PIN.",
    inputSchema: NO_ARGS,
    gate: "pin",
    async run(_args, ctx) {
      await ctx.adapter.openTrunk();
      return { verified: true, text: "Trunk command sent and accepted." };
    },
  },
  {
    name: "open_frunk",
    description: "Open the front trunk. Requires the owner's PIN.",
    inputSchema: NO_ARGS,
    gate: "pin",
    async run(_args, ctx) {
      await ctx.adapter.openFrunk();
      return { verified: true, text: "Frunk command sent and accepted." };
    },
  },
  {
    name: "honk_horn",
    description: "Honk the horn.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      await ctx.adapter.honkHorn();
      return { verified: true, text: "Honked." };
    },
  },
  {
    name: "flash_lights",
    description: "Flash the lights.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      await ctx.adapter.flashLights();
      return { verified: true, text: "Flashed the lights." };
    },
  },
  {
    name: "sentry_on",
    description: "Turn Sentry Mode on.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      return verifyAfter(
        ctx,
        () => ctx.adapter.sentryOn(),
        (s) => s,
        (s) => ({ verified: s.sentryOn, text: `Sentry ${s.sentryOn ? "on" : "still off"}.` }),
      );
    },
  },
  {
    name: "sentry_off",
    description: "Turn Sentry Mode off.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      return verifyAfter(
        ctx,
        () => ctx.adapter.sentryOff(),
        (s) => s,
        (s) => ({ verified: !s.sentryOn, text: `Sentry ${s.sentryOn ? "still on" : "off"}.` }),
      );
    },
  },
  {
    // No vented/closed telemetry field exists either (same reasoning as trunk/frunk
    // above) — rely on the adapter's result:true check instead of an unreadable field.
    name: "vent_windows",
    description: "Vent the windows.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      await ctx.adapter.ventWindows();
      return { verified: true, text: "Window vent command sent and accepted." };
    },
  },
  {
    name: "close_windows",
    description: "Close the windows.",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      await ctx.adapter.closeWindows();
      return { verified: true, text: "Window close command sent and accepted." };
    },
  },
  {
    // No nav-destination-accepted telemetry field exists on vehicle state either.
    name: "nav_send_destination",
    description: "Send a destination address to the car's navigation.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Destination address or place name" } },
      required: ["address"],
    },
    gate: "none",
    async run(args, ctx) {
      const address = String(args.address);
      await ctx.adapter.navSendDestination(address);
      return { verified: true, text: `Sent "${address}" to your nav (accepted). Pull it up on the car screen.` };
    },
  },
  {
    name: "set_scheduled_departure",
    description:
      "Set the car's own scheduled-departure feature (precondition the cabin to be ready by a departure time). " +
      "This is the vehicle's native feature, not an app-level schedule — cancel it by asking to turn scheduled departure off, not CANCEL.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "string", description: "Departure time, ISO 8601" },
        preconditionEnabled: { type: "boolean", description: "Whether to precondition the cabin before departure" },
      },
      required: ["time", "preconditionEnabled"],
    },
    gate: "none",
    async run(args, ctx) {
      const time = String(args.time);
      const preconditionEnabled = Boolean(args.preconditionEnabled);
      await ctx.adapter.setScheduledDeparture(time, preconditionEnabled);
      return {
        verified: true,
        // Deliberately does NOT say "Reply CANCEL to cancel" — CANCEL only touches
        // this app's own SQLite triggers, and this is the vehicle's own native
        // departure config, not a trigger. See agent.ts's nativeDepartureCancelHint
        // for how a later "turn it off" request actually disables it.
        text:
          `Got it. ${preconditionEnabled ? "Preconditioning" : "Departure"} will start to be ready by ${time} ` +
          `(accepted by the car). Ask me to turn scheduled departure off if you want to cancel it — that's a ` +
          `different command from CANCEL, which only cancels things I scheduled myself.`,
      };
    },
  },
  {
    // Disables the vehicle's own native scheduled-departure feature. Separate tool
    // (not reusing set_scheduled_departure) so the agent has an explicit, named way
    // to honor "turn off scheduled departure" / "cancel the departure schedule".
    name: "cancel_scheduled_departure",
    description: "Turn off the car's native scheduled-departure feature (the one set by set_scheduled_departure).",
    inputSchema: NO_ARGS,
    gate: "none",
    async run(_args, ctx) {
      await ctx.adapter.setScheduledDeparture(new Date(ctx.now.getTime()).toISOString(), false);
      return { verified: true, text: "Scheduled departure turned off." };
    },
  },
  {
    // The Roadster's flight commands (land/hover/jump/thrust_mode) are in the manifest as
    // awaiting_fleet_api: Tesla showed them on 15 Oct 2026 and has published no endpoint.
    // This tool is the ONLY place they route, and it touches nothing — no adapter call,
    // no raw HTTP — it just says so. When Tesla ships an endpoint, add a real tool under
    // the same never-drives-the-car rule; never route a flight request to any existing
    // vehicle function as a stand-in.
    name: "roadster_flight",
    description:
      "Handle any request to fly, hover, land, jump, or use the Roadster's thrusters. Reports honestly that " +
      "Tesla has not published Roadster flight endpoints yet. Takes no action on the vehicle.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "One of the manifest's flight commands: land, hover, jump, thrust_mode",
        },
        where: { type: "string", description: "Where the owner asked it to go, if they said (e.g. 'the roof')" },
      },
      required: ["command"],
    },
    gate: "none",
    async run(args) {
      const requested = String(args.command ?? "");
      const entry = findEntry(requested);
      const known = entry && entry.status === "awaiting_fleet_api" ? entry : null;
      const list = awaiting()
        .map((e) => e.name)
        .join(", ");
      const where = args.where ? ` (${String(args.where)})` : "";
      const head = known
        ? `${known.name}${where} is in the manifest for the ${known.variants.join("/")} Roadster, status: awaiting_fleet_api.`
        : `"${requested}" isn't a Roadster flight command I know; the manifest has: ${list}.`;
      return {
        verified: true,
        text:
          `${head} Tesla hasn't published Roadster flight endpoints yet (production target 2028). ` +
          `I'll do it the day they ship. Nothing was sent to the car.`,
      };
    },
  },
  {
    name: "schedule_action",
    description:
      "Schedule any other tool to run at a future time (used for every 'in N minutes' / 'at X' phrasing). Wraps the named tool and its args. " +
      "The time must be in the future relative to the current server time given in the system prompt.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Name of the tool to run later" },
        args: { type: "object", description: "Arguments for that tool" },
        whenISO: { type: "string", description: "When to run it, ISO 8601" },
      },
      required: ["tool", "whenISO"],
    },
    gate: "confirm",
    async run(args, ctx) {
      const toolName = String(args.tool);
      const toolArgs = (args.args as Record<string, unknown>) ?? {};
      const whenISO = String(args.whenISO);
      const fireAt = Date.parse(whenISO);

      const wrapped = findTool(toolName);
      if (!wrapped) {
        return { verified: false, text: `"${toolName}" isn't a command I can schedule.` };
      }
      if (Number.isNaN(fireAt)) {
        return { verified: false, text: `"${whenISO}" isn't a time I can parse.` };
      }
      // Reject anything that isn't meaningfully in the future — a malformed relative
      // time ("in 15 min" parsed against the wrong now) must not silently fire
      // immediately. A few seconds of slack covers normal round-trip latency.
      if (fireAt < ctx.now.getTime() - 5_000) {
        return { verified: false, text: `That time (${whenISO}) is in the past — tell me again relative to now.` };
      }
      // Inherits the wrapped tool's PIN gate: scheduling an unlock/trunk/frunk for
      // later must require the same PIN the immediate path would, not bypass it.
      // agent.ts's effectiveGateRequiresPin holds this call for the PIN BEFORE run()
      // is ever reached when wrapped.gate === "pin" and ctx.pinVerified is false — this
      // check is the defense-in-depth backstop, not the only gate.
      if (wrapped.gate === "pin" && !ctx.pinVerified) {
        return { verified: false, text: "That needs your PIN first — reply with it to confirm." };
      }

      ctx.scheduler.schedule({
        channel: ctx.channel,
        chatId: ctx.chatId,
        toolName,
        toolArgs,
        fireAt,
        replyContext: toolName,
        pinVerified: wrapped.gate !== "pin" || ctx.pinVerified,
      });
      return { verified: true, text: `Got it. Running "${toolName}" at ${whenISO}. Reply CANCEL to cancel.` };
    },
  },
];

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
