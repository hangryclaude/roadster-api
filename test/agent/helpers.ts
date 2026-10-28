// Fakes shared by test/agent/*.test.ts: a scripted Anthropic client, an in-memory
// VehicleAdapterLike, and an in-memory SchedulerLike. No network, no real DB file —
// agent.test.ts points handleInbound at these instead of real deps.

import type { AnthropicClientLike, AnthropicCreateParams, AnthropicResponse } from "../../src/agent/anthropic.ts";
import type { ScheduledTrigger, ScheduleRequest, SchedulerLike, VehicleAdapterLike, VehicleState } from "../../src/agent/types.ts";

export function scriptedClient(responses: AnthropicResponse[]): AnthropicClientLike & { calls: AnthropicCreateParams[] } {
  const queue = [...responses];
  const calls: AnthropicCreateParams[] = [];
  return {
    calls,
    async createMessage(params) {
      calls.push(params);
      const next = queue.shift();
      if (!next) throw new Error("scriptedClient: ran out of scripted responses");
      return next;
    },
  };
}

export function fakeAdapter(overrides: Partial<VehicleState> = {}): VehicleAdapterLike & { state: VehicleState } {
  const state: VehicleState = {
    odometerMiles: 0,
    batteryPercent: 50,
    chargingState: "Stopped",
    chargeLimitPercent: 80,
    locked: true,
    sentryOn: false,
    climateOn: false,
    insideTempF: null,
    climateTargetF: null,
    chargePortOpen: false,
    latitude: 0,
    longitude: 0,
    address: "test address",
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
  return {
    state,
    async getState() {
      return { ...state };
    },
    async climateOn() {
      state.climateOn = true;
      state.insideTempF = 65;
    },
    async climateOff() {
      state.climateOn = false;
    },
    async setClimateTemp(tempF) {
      state.climateTargetF = tempF;
    },
    async lock() {
      state.locked = true;
    },
    async unlock() {
      state.locked = false;
    },
    async chargeStart() {
      state.chargingState = "Charging";
    },
    async chargeStop() {
      state.chargingState = "Stopped";
    },
    async setChargeLimit(percent) {
      state.chargeLimitPercent = percent;
    },
    async openChargePort() {
      state.chargePortOpen = true;
    },
    async closeChargePort() {
      state.chargePortOpen = false;
    },
    async openTrunk() {},
    async openFrunk() {},
    async honkHorn() {},
    async flashLights() {},
    async sentryOn() {
      state.sentryOn = true;
    },
    async sentryOff() {
      state.sentryOn = false;
    },
    async ventWindows() {},
    async closeWindows() {},
    async navSendDestination() {},
    async setScheduledDeparture() {},
  };
}

export function fakeScheduler(): SchedulerLike & { triggers: ScheduledTrigger[] } {
  const triggers: ScheduledTrigger[] = [];
  let nextId = 1;
  return {
    triggers,
    schedule(req: ScheduleRequest) {
      const trigger: ScheduledTrigger = {
        ...req,
        id: String(nextId++),
        status: "pending",
        createdAt: Date.now(),
        pinVerified: req.pinVerified ?? true,
      };
      triggers.push(trigger);
      return trigger;
    },
    cancelLatestPending(channel, chatId) {
      const match = [...triggers]
        .reverse()
        .find((t) => t.channel === channel && t.chatId === chatId && t.status === "pending");
      if (!match) return null;
      match.status = "cancelled";
      return match;
    },
  };
}
