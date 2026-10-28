// VehicleAdapter: one interface, two implementations (TessieAdapter now,
// FleetApiAdapter later) so the agent and scheduler never know which backend is live.
//
// No method here that isn't a tool, no method for Autopilot/FSD/Summon/speed/drive.
// That's not an oversight — see SPEC.md "What this will never do." Do not add one;
// refuse instead, in code and in docs.

export interface VehicleState {
  odometerMiles: number;
  batteryPercent: number;
  chargingState: "Charging" | "Stopped" | "Complete" | "Disconnected";
  chargeLimitPercent: number;
  // null means "telemetry absent" — never default a missing lock field to false (or
  // true); a stale/partial read must read as unknown, not as a confirmed state.
  locked: boolean | null;
  sentryOn: boolean;
  climateOn: boolean;
  insideTempF: number | null;
  climateTargetF: number | null; // the set-point, not ambient
  chargePortOpen: boolean | null;
  latitude: number;
  longitude: number;
  address: string | null;
  updatedAt: string; // the vehicle's own telemetry timestamp, so "re-read before confirming" is checkable
}

export interface VehicleAdapter {
  // realtime:true bypasses Tessie's cached state endpoint — use it for the
  // post-command verification read, where a cached response could falsely confirm
  // (or fail to confirm) a change that just happened.
  getState(opts?: { realtime?: boolean }): Promise<VehicleState>;
  wake(): Promise<void>;

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
  // enabled defaults to true (configuring a new departure); pass false to disable
  // the native feature entirely, which is what cancel_scheduled_departure uses.
  setScheduledDeparture(time: string, preconditionEnabled: boolean, enabled?: boolean): Promise<void>;

  // No autopilot(), no fsd(), no summon(), no setSpeed(), no drive(). Not an oversight —
  // see SPEC.md "What this will never do." Do not add one; refuse instead.
}
