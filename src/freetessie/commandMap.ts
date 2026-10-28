// commandMap: translates TessieAdapter's 21-name command vocabulary into the Fleet API
// call that actually implements it. Route table is docs/FREETESSIE-BRIEF.md §3; Fleet-side
// field names verified against pkg/proxy/command.go (teslamotors/vehicle-command) and
// python-tesla-fleet-api, same as fleetClient.ts.
//
// Same hard rule as everywhere else in this repo: the vocabulary this file accepts is
// exactly TESSIE_COMMANDS. Anything else — in particular anything Autopilot/FSD/Summon/
// speed/drive-shaped — throws UnknownCommandError. There is no fallthrough case that
// forwards an unrecognized name anywhere.

import {
  UnknownCommandError,
  type CommandPlan,
  type FleetCommandName,
  type PlanCommand,
} from "./contracts.ts";

function signed(name: FleetCommandName, body?: Record<string, unknown>): CommandPlan {
  return { kind: "signed", name, body };
}

// Tessie's own query params are already strings (TessieAdapter.mapToStrings); every
// numeric/boolean param this module reads comes back through that same wire shape.
function requireNumber(
  query: Record<string, string>,
  key: string,
  bounds: { min: number; max: number },
  fallback?: number,
): number {
  const raw = query[key];
  if (raw === undefined && fallback !== undefined) return fallback;
  const n = Number(raw);
  if (raw === undefined || raw === "" || Number.isNaN(n)) {
    throw new Error(`command parameter "${key}" must be a number`);
  }
  if (n < bounds.min || n > bounds.max) {
    throw new Error(
      `command parameter "${key}" must be between ${bounds.min} and ${bounds.max}`,
    );
  }
  return n;
}

// Present-or-absent numeric param; only a present-but-unparseable value is an error.
function optionalNumber(query: Record<string, string>, key: string): number | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw === "" || Number.isNaN(n)) {
    throw new Error(`command parameter "${key}" must be a number`);
  }
  return n;
}

function requireBool(
  query: Record<string, string>,
  key: string,
  fallback?: boolean,
): boolean {
  const raw = query[key];
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`command parameter "${key}" is required`);
  }
  if (raw !== "true" && raw !== "false") {
    throw new Error(`command parameter "${key}" must be "true" or "false"`);
  }
  return raw === "true";
}

function requireString(query: Record<string, string>, key: string): string {
  const raw = query[key];
  if (!raw) {
    throw new Error(`command parameter "${key}" is required`);
  }
  return raw;
}

export const planCommand: PlanCommand = (tessieName, query) => {
  switch (tessieName) {
    case "wake":
      return { kind: "wake" };

    case "start_climate":
      return signed("auto_conditioning_start");
    case "stop_climate":
      return signed("auto_conditioning_stop");

    case "set_temperatures": {
      // Tessie takes one Celsius value; Fleet wants a driver/passenger split. Split the
      // one value to both fields — TessieAdapter's own callers don't distinguish either,
      // matching the brief's §3 note. Bounds match Tessie's own documented 15-28°C range
      // so an out-of-range request 400s the same way it would against api.tessie.com,
      // rather than silently accepting a wider range Fleet itself would reject upstream.
      const tempC = requireNumber(query, "temperature", { min: 15, max: 28 });
      return signed("set_temps", { driver_temp: tempC, passenger_temp: tempC });
    }

    case "lock":
      return signed("door_lock");
    case "unlock":
      return signed("door_unlock");

    case "start_charging":
      return signed("charge_start");
    case "stop_charging":
      return signed("charge_stop");
    case "set_charge_limit": {
      const percent = requireNumber(query, "percent", { min: 1, max: 100 });
      return signed("set_charge_limit", { percent });
    }
    case "open_charge_port":
      return signed("charge_port_door_open");
    case "close_charge_port":
      return signed("charge_port_door_close");

    case "activate_rear_trunk":
      return signed("actuate_trunk", { which_trunk: "rear" });
    case "activate_front_trunk":
      return signed("actuate_trunk", { which_trunk: "front" });

    case "honk":
      return signed("honk_horn");
    case "flash":
      return signed("flash_lights");

    case "enable_sentry":
      return signed("set_sentry_mode", { on: true });
    case "disable_sentry":
      return signed("set_sentry_mode", { on: false });

    case "vent_windows":
    case "close_windows": {
      // Fleet's signed window_control is proximity-gated on close: lat/lon must be near
      // the car. TessieAdapter sends none (real Tessie resolves them server-side), so
      // server.ts injects the car's own cached position into the query before planning
      // and refuses close when it has none. 0,0 only ever reaches Tesla for a vent with
      // no known position, which the car accepts.
      const lat = optionalNumber(query, "lat") ?? 0;
      const lon = optionalNumber(query, "lon") ?? 0;
      const command = tessieName === "vent_windows" ? "vent" : "close";
      return signed("window_control", { command, lat, lon });
    }

    case "share": {
      // Tessie's wire contract is {value: <address>} — TessieAdapter.navSendDestination
      // sends it as the query param "value".
      const address = requireString(query, "value");
      return { kind: "navigation", address };
    }

    case "schedule_departure": {
      const enable = requireBool(query, "enable");
      if (!enable) {
        // Matches teslamotors/vehicle-command's own ClearScheduledDeparture path: a plain
        // {enable:false} clears it, no other field required.
        return signed("set_scheduled_departure", { enable: false });
      }
      const departureTime = requireNumber(query, "departure_time", {
        min: 0,
        max: 1439,
      });
      const preconditioningEnabled = requireBool(
        query,
        "preconditioning_enabled",
        false,
      );
      // Fleet's schema is richer than Tessie's single-flag contract (confirmed against
      // pkg/proxy/command.go's set_scheduled_departure case and python-tesla-fleet-api's
      // set_scheduled_departure()), but Tessie documents these four as real, honored
      // optional params too — read them from query (defaulting off/0, same as before)
      // instead of silently dropping whatever the caller explicitly asked for.
      const preconditioningWeekdaysOnly = requireBool(
        query,
        "preconditioning_weekdays_only",
        false,
      );
      const offPeakChargingEnabled = requireBool(
        query,
        "off_peak_charging_enabled",
        false,
      );
      const offPeakChargingWeekdaysOnly = requireBool(
        query,
        "off_peak_charging_weekdays_only",
        false,
      );
      const endOffPeakTime = requireNumber(
        query,
        "end_off_peak_time",
        { min: 0, max: 1439 },
        0,
      );
      return signed("set_scheduled_departure", {
        enable: true,
        departure_time: departureTime,
        preconditioning_enabled: preconditioningEnabled,
        preconditioning_weekdays_only: preconditioningWeekdaysOnly,
        off_peak_charging_enabled: offPeakChargingEnabled,
        off_peak_charging_weekdays_only: offPeakChargingWeekdaysOnly,
        end_off_peak_time: endOffPeakTime,
      });
    }

    default:
      throw new UnknownCommandError(tessieName);
  }
};
