// Minimal local interfaces for everything this module depends on across package
// boundaries. Deliberately NOT imported from src/tesla or src/scheduler — those are
// owned by other agents working in parallel; importing their types here would couple
// this module's compile to files it doesn't own. Shapes mirror ARCHITECTURE.md.

export interface VehicleState {
  odometerMiles: number;
  batteryPercent: number;
  chargingState: "Charging" | "Stopped" | "Complete" | "Disconnected";
  chargeLimitPercent: number;
  // null means "telemetry absent" — never assume unlocked (or locked) from a missing
  // field; that's the cached/missing-telemetry bug this type exists to prevent.
  locked: boolean | null;
  sentryOn: boolean;
  climateOn: boolean;
  insideTempF: number | null;
  climateTargetF: number | null; // the set-point, not ambient — what set_climate_temp can verify against
  chargePortOpen: boolean | null;
  latitude: number;
  longitude: number;
  address: string | null;
  updatedAt: string; // the vehicle's own telemetry timestamp, not fetch time — null-safe fallback only if truly absent
}

// One method per row in SPEC.md's tool list. No method here for Autopilot, FSD,
// Summon, speed, or drive — not an oversight, see SPEC.md "What this will never do."
// Refuse any request to add one; do not work around this via raw HTTP either.
export interface VehicleAdapterLike {
  getState(opts?: { realtime?: boolean }): Promise<VehicleState>;
  climateOn(): Promise<void>;
  climateOff(): Promise<void>;
  setClimateTemp(tempF: number): Promise<void>;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  chargeStart(): Promise<void>;
  chargeStop(): Promise<void>;
  setChargeLimit(percent: number): Promise<void>;
  openChargePort(): Promise<void>;
  closeChargePort(): Promise<void>;
  openTrunk(): Promise<void>;
  openFrunk(): Promise<void>;
  honkHorn(): Promise<void>;
  flashLights(): Promise<void>;
  sentryOn(): Promise<void>;
  sentryOff(): Promise<void>;
  ventWindows(): Promise<void>;
  closeWindows(): Promise<void>;
  navSendDestination(address: string): Promise<void>;
  setScheduledDeparture(time: string, preconditionEnabled: boolean, enabled?: boolean): Promise<void>;
}

export interface ScheduleRequest {
  channel: string;
  chatId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  fireAt: number; // unix ms
  replyContext: string;
  // True once a PIN has actually been verified for a pin-gated wrapped tool (or the
  // wrapped tool needs no PIN at all). The poller re-checks this before dispatching a
  // pin-gated action — schedule_action must never be a way to skip the PIN gate.
  // Optional on the request (defaults to true in scheduleTrigger) so existing
  // non-PIN scheduling call sites don't need to think about it.
  pinVerified?: boolean;
}

export interface ScheduledTrigger extends ScheduleRequest {
  id: string;
  status: "pending" | "fired" | "cancelled";
  createdAt: number;
  pinVerified: boolean; // always concrete once stored — see ScheduleRequest.pinVerified
}

export interface SchedulerLike {
  schedule(req: ScheduleRequest): ScheduledTrigger;
  cancelLatestPending(channel: string, chatId: string): ScheduledTrigger | null;
}

export interface InboundMessageLike {
  channel: string;
  chatId: string;
  text: string;
}
