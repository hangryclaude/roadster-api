// TessieAdapter: primary VehicleAdapter implementation, backed by the Tessie API
// (https://api.tessie.com). VIN-scoped REST endpoints, bearer auth.
//
// Same hard rule as adapter.ts: no Autopilot/FSD/Summon/speed/drive methods here.
// Tessie's API surfaces things like "drive_state" and in principle could be asked to
// proxy a Summon/Autopilot-adjacent command — we don't call any such endpoint, ever.
// If a future task asks for one, refuse and point back to SPEC.md "What this will
// never do" rather than wiring it up here.

import type { VehicleAdapter, VehicleState } from "./adapter.ts";

const DEFAULT_BASE_URL = "https://api.tessie.com";

// Raw shape of Tessie's GET /{vin}/state response (subset we actually read).
// Tessie mirrors Tesla's own vehicle_data nesting (vehicle_state/charge_state/
// climate_state/drive_state), it just adds its own fields alongside. Each category
// carries its own `timestamp` (vehicle-reported, ms epoch) — we prefer that over
// wall-clock time when stamping VehicleState.updatedAt.
interface TessieStateResponse {
  vehicle_state?: {
    odometer?: number; // miles
    locked?: boolean;
    sentry_mode?: boolean;
    charge_port_door_open?: boolean;
    timestamp?: number;
  };
  charge_state?: {
    battery_level?: number; // percent
    charge_limit_soc?: number; // percent
    charging_state?: string; // "Charging" | "Stopped" | "Complete" | "Disconnected" | others
    timestamp?: number;
  };
  climate_state?: {
    is_climate_on?: boolean;
    inside_temp?: number; // Celsius
    driver_temp_setting?: number; // Celsius, the set-point (not ambient)
    timestamp?: number;
  };
  drive_state?: {
    latitude?: number;
    longitude?: number;
    timestamp?: number;
  };
  address?: string; // Tessie resolves this itself, unlike raw Tesla API
}

function cToF(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

function fToC(fahrenheit: number): number {
  return ((fahrenheit - 32) * 5) / 9;
}

// Picks the newest of the per-category vehicle timestamps Tessie reports. Falls back
// to "now" only when every category is missing one (e.g. an empty/partial response) —
// that fallback is explicitly NOT a vehicle-verified time, just the least-wrong value
// available, and callers verifying freshness should prefer a real field when present.
function pickTimestamp(raw: TessieStateResponse): string {
  const candidates = [
    raw.vehicle_state?.timestamp,
    raw.charge_state?.timestamp,
    raw.climate_state?.timestamp,
    raw.drive_state?.timestamp,
  ].filter((t): t is number => typeof t === "number");
  if (candidates.length === 0) return new Date().toISOString();
  return new Date(Math.max(...candidates)).toISOString();
}

// Maps a raw Tessie state response onto this project's VehicleAdapter-level VehicleState.
// Kept separate from the fetch call so tests can feed it fixtures directly.
export function normalizeState(raw: TessieStateResponse): VehicleState {
  const chargingState = raw.charge_state?.charging_state;
  const knownChargingStates = ["Charging", "Stopped", "Complete", "Disconnected"] as const;
  const normalizedChargingState = (
    knownChargingStates as readonly string[]
  ).includes(chargingState ?? "")
    ? (chargingState as VehicleState["chargingState"])
    : "Disconnected";

  return {
    odometerMiles: raw.vehicle_state?.odometer ?? 0,
    batteryPercent: raw.charge_state?.battery_level ?? 0,
    chargingState: normalizedChargingState,
    chargeLimitPercent: raw.charge_state?.charge_limit_soc ?? 0,
    // Absent lock telemetry is unknown, never a confirmed false — a stale/partial read
    // must not be able to masquerade as "definitely unlocked".
    locked: raw.vehicle_state?.locked ?? null,
    sentryOn: raw.vehicle_state?.sentry_mode ?? false,
    climateOn: raw.climate_state?.is_climate_on ?? false,
    insideTempF:
      raw.climate_state?.inside_temp == null ? null : cToF(raw.climate_state.inside_temp),
    climateTargetF:
      raw.climate_state?.driver_temp_setting == null
        ? null
        : cToF(raw.climate_state.driver_temp_setting),
    chargePortOpen: raw.vehicle_state?.charge_port_door_open ?? null,
    latitude: raw.drive_state?.latitude ?? 0,
    longitude: raw.drive_state?.longitude ?? 0,
    address: raw.address ?? null,
    updatedAt: pickTimestamp(raw),
  };
}

// Tessie's command response shape: HTTP 200 does not mean the command succeeded —
// `result` is the actual pass/fail. https://developer.tessie.com/reference/flash-lights
interface TessieCommandResponse {
  result?: boolean;
  [key: string]: unknown;
}

export class TessieAdapter implements VehicleAdapter {
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    private readonly vin: string,
    baseUrl: string = process.env.TESSIE_BASE_URL ?? DEFAULT_BASE_URL,
  ) {
    this.baseUrl = baseUrl;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Tessie API ${path} failed: ${res.status} ${body}`);
    }
    const text = await res.text();
    return text.length > 0 ? JSON.parse(text) : {};
  }

  // Every command route goes through here so the result:false check (Tessie's own
  // documented pass/fail field, distinct from HTTP status) happens exactly once.
  private async command(
    name: string,
    query?: Record<string, string | number | boolean>,
  ): Promise<void> {
    const qs = query ? `?${new URLSearchParams(mapToStrings(query)).toString()}` : "";
    const raw = (await this.request(`/${this.vin}/command/${name}${qs}`, {
      method: "POST",
    })) as TessieCommandResponse;
    if (raw.result === false) {
      throw new Error(`Tessie command "${name}" reported result:false`);
    }
  }

  async getState(opts?: { realtime?: boolean }): Promise<VehicleState> {
    // Tessie caches /state by default; the post-command verification read needs the
    // real-time option so a cached response can't falsely confirm (or fail to
    // confirm) a change that just happened. https://developer.tessie.com/reference/get-vehicle
    const qs = opts?.realtime ? "?use_cache=false" : "";
    const raw = (await this.request(`/${this.vin}/state${qs}`)) as TessieStateResponse;
    return normalizeState(raw);
  }

  async wake(): Promise<void> {
    await this.command("wake");
  }

  async climateOn(): Promise<void> {
    await this.command("start_climate");
  }

  async climateOff(): Promise<void> {
    await this.command("stop_climate");
  }

  async setClimateTemp(tempF: number): Promise<void> {
    // Tessie's set-temperature command takes a single `temperature` param (Celsius),
    // not the driver/passenger split the raw Tesla API uses.
    // https://developer.tessie.com/reference/set-temperature
    const tempC = fToC(tempF);
    await this.command("set_temperatures", { temperature: tempC.toFixed(1) });
  }

  async lock(): Promise<void> {
    await this.command("lock");
  }

  async unlock(): Promise<void> {
    await this.command("unlock");
  }

  async chargeStart(): Promise<void> {
    await this.command("start_charging");
  }

  async chargeStop(): Promise<void> {
    await this.command("stop_charging");
  }

  async setChargeLimit(percent: number): Promise<void> {
    await this.command("set_charge_limit", { percent });
  }

  async openChargePort(): Promise<void> {
    await this.command("open_charge_port");
  }

  async closeChargePort(): Promise<void> {
    await this.command("close_charge_port");
  }

  async openTrunk(): Promise<void> {
    // Tessie's documented rear-trunk command is activate_rear_trunk, not open_trunk.
    // https://developer.tessie.com/reference/rear-trunk
    await this.command("activate_rear_trunk");
  }

  async openFrunk(): Promise<void> {
    // Tessie's documented front-trunk command is activate_front_trunk, not open_frunk.
    // https://developer.tessie.com/reference/front-trunk
    await this.command("activate_front_trunk");
  }

  async honkHorn(): Promise<void> {
    await this.command("honk");
  }

  async flashLights(): Promise<void> {
    await this.command("flash");
  }

  async sentryOn(): Promise<void> {
    await this.command("enable_sentry");
  }

  async sentryOff(): Promise<void> {
    await this.command("disable_sentry");
  }

  async ventWindows(): Promise<void> {
    await this.command("vent_windows");
  }

  async closeWindows(): Promise<void> {
    await this.command("close_windows");
  }

  async navSendDestination(address: string): Promise<void> {
    // Tessie's documented nav-share contract is POST /{vin}/command/share?value=...,
    // not /{vin}/share?address=... — https://developer.tessie.com/reference/share
    await this.command("share", { value: address });
  }

  async setScheduledDeparture(
    time: string,
    preconditionEnabled: boolean,
    enabled = true,
  ): Promise<void> {
    // Tessie's documented contract wants minutes past local midnight and an explicit
    // `enable` flag, not an ISO timestamp. https://developer.tessie.com/reference/set-scheduled-departure
    const departure = new Date(time);
    const minutesPastMidnight = departure.getHours() * 60 + departure.getMinutes();
    await this.command("schedule_departure", {
      enable: enabled,
      departure_time: minutesPastMidnight,
      preconditioning_enabled: preconditionEnabled,
    });
  }
}

function mapToStrings(
  query: Record<string, string | number | boolean>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    out[k] = String(v);
  }
  return out;
}
