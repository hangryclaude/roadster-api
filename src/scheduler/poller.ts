// 10s interval poller. startPoller returns { stop() } specifically so tests can call
// it in a finally block and let node --test exit — the interval timer is otherwise
// an open handle that hangs the runner.

import type { DatabaseSync } from "node:sqlite";
import type { VehicleAdapter } from "../tesla/adapter.ts";
import type { Channel } from "../channels/channel.ts";
import { dueTriggers, markFired, scheduleTrigger, cancelLatestPending, type Trigger } from "./triggers.ts";
import { TOOLS } from "../agent/tools.ts";
import type { SchedulerLike, ScheduleRequest } from "../agent/types.ts";

// A due trigger has already fired — its toolArgs never include schedule_action (the
// agent only ever schedules concrete vehicle tools), but the Tool.run signature still
// asks for a SchedulerLike. This adapts the real triggers table to that interface so
// a fired trigger could in principle re-schedule itself; nothing here calls it.
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

// Selects due triggers and marks each `fired` before returning them, so a crash
// between poll() and running the tool can't double-fire the same trigger on the
// next tick. Exposed standalone (not just inlined in startPoller's interval body)
// so tests can drive it with an injected clock instead of real timers.
export function poll(db: DatabaseSync, nowMs: number): Trigger[] {
  const due = dueTriggers(db, nowMs);
  for (const trigger of due) {
    markFired(db, trigger.id);
  }
  return due;
}

// Test/e2e polling helper only — NOT wired into the live fire-trigger path. It
// resolves once readState() reports the predicate satisfied, never on "request
// sent", but the only callers are test/scheduler.test.ts and scripts/e2e.ts,
// polling the fake vehicle's local state directly. The real per-trigger
// verification on the live path is tools.ts's verifyAfter (one live read), not
// this. Kept here (rather than a test-utils module) because scripts/e2e.ts also
// imports it. Polls readState on a short interval of its own; rejects on timeout
// rather than confirming a change that was never observed.
export async function runThenVerify<TState>(
  action: () => Promise<void>,
  readState: () => Promise<TState>,
  predicate: (state: TState) => boolean,
  timeoutMs: number,
): Promise<TState> {
  await action();
  const deadline = Date.now() + timeoutMs;
  const checkIntervalMs = Math.min(1000, Math.max(50, Math.floor(timeoutMs / 10)));
  for (;;) {
    const state = await readState();
    if (predicate(state)) return state;
    if (Date.now() >= deadline) {
      throw new Error(`runThenVerify: predicate not satisfied within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
  }
}

async function fireTrigger(
  trigger: Trigger,
  adapter: VehicleAdapter,
  channels: Map<Trigger["channel"], Channel>,
  db: DatabaseSync,
): Promise<void> {
  const channel = channels.get(trigger.channel);
  if (!channel) return; // nothing to dispatch to yet — channel wiring owned elsewhere

  const tool = TOOLS.find((t) => t.name === trigger.toolName);
  if (!tool) {
    // An unknown tool name must have been rejected at schedule time (tools.ts's
    // schedule_action validates against the registry) — this branch only exists for
    // defense in depth. Either way, the owner gets told nothing ran, instead of the
    // trigger silently vanishing as "fired".
    await channel.send(
      trigger.chatId,
      `Scheduled action for "${trigger.toolName}" couldn't run — that's not a command I recognize. Nothing happened.`,
    );
    return;
  }

  // The poller re-runs the SAME PIN gate the immediate path uses: schedule_action
  // storing pinVerified=false (or dropping the bit entirely) must never let a
  // pin-gated tool run unattended. This is the backstop even if tools.ts's
  // schedule-time check is ever bypassed.
  if (tool.gate === "pin" && !trigger.pinVerified) {
    await channel.send(
      trigger.chatId,
      `Scheduled "${trigger.toolName}" needs your PIN, which was never confirmed when this was scheduled — skipped for safety.`,
    );
    return;
  }

  try {
    const result = await tool.run(trigger.toolArgs, {
      adapter,
      scheduler: schedulerFor(db),
      channel: trigger.channel,
      chatId: trigger.chatId,
      pinVerified: trigger.pinVerified,
      now: new Date(),
    });
    await channel.send(trigger.chatId, result.text);
  } catch (err) {
    // A failed dispatch (e.g. Tessie unreachable) must reach the owner, not just the
    // server log — "warm up in 15 min" silently never happening is the bug this
    // catch exists to close.
    const message = err instanceof Error ? err.message : String(err);
    await channel.send(trigger.chatId, `Scheduled "${trigger.toolName}" failed to run: ${message}`);
    throw err;
  }
}

export function startPoller(opts: {
  db: DatabaseSync;
  adapter: VehicleAdapter;
  channels: Map<Trigger["channel"], Channel>;
  intervalMs?: number; // default 10_000
}): { stop(): void } {
  // Guards against overlapping ticks: if a run of fireDue() is still working through
  // triggers from the previous tick, the next interval skips rather than starting a
  // second concurrent pass (which is exactly how two triggers for the same vehicle —
  // e.g. climate-off then climate-on — could race and finish in the wrong order).
  let running = false;

  async function fireDue(): Promise<void> {
    const due = poll(opts.db, Date.now());
    // Dispatched strictly one at a time, in fire order, awaiting each before starting
    // the next — never Promise.all / fire-and-forget, so two triggers can't race.
    for (const trigger of due) {
      try {
        await fireTrigger(trigger, opts.adapter, opts.channels, opts.db);
      } catch (err) {
        console.error(`poller: failed to fire trigger ${trigger.id}`, err);
      }
    }
  }

  const handle = setInterval(() => {
    if (running) return;
    running = true;
    fireDue()
      .catch((err) => console.error("poller: tick failed", err))
      .finally(() => {
        running = false;
      });
  }, opts.intervalMs ?? 10_000);

  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
