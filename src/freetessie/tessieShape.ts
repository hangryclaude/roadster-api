// Maps Fleet API's vehicle_data shape onto the exact Tessie-shaped JSON
// src/tesla/tessieAdapter.ts's normalizeState() reads — so TessieAdapter needs zero code
// changes when TESSIE_BASE_URL points at freetessie instead of api.tessie.com. Field names
// and per-category timestamps are Tesla's own (Tessie mirrors them unchanged); `address` is
// the one field Fleet API doesn't have, resolved by the caller (reverse geocode) and passed
// in here rather than invented.

import type { FleetVehicleData } from "./contracts.ts";

// Mirrors tessieAdapter.ts's own (unexported) TessieStateResponse shape. Kept as a
// structural match rather than a shared import so this file has no dependency on that
// adapter's internals beyond the wire contract itself.
export interface TessieStateShape {
  vehicle_state: {
    odometer?: number;
    locked?: boolean;
    sentry_mode?: boolean;
    charge_port_door_open?: boolean;
    timestamp?: number;
  };
  charge_state: {
    battery_level?: number;
    charge_limit_soc?: number;
    charging_state?: string;
    timestamp?: number;
  };
  climate_state: {
    is_climate_on?: boolean;
    inside_temp?: number;
    driver_temp_setting?: number;
    timestamp?: number;
  };
  drive_state: {
    latitude?: number;
    longitude?: number;
    timestamp?: number;
  };
  // normalizeState reads `address?: string`, not `string | null` — undefined, not null,
  // is "no address" on the wire.
  address?: string;
}

export function toTessieState(data: FleetVehicleData, address: string | null): TessieStateShape {
  return {
    vehicle_state: {
      odometer: data.vehicle_state?.odometer,
      locked: data.vehicle_state?.locked,
      sentry_mode: data.vehicle_state?.sentry_mode,
      charge_port_door_open: data.vehicle_state?.charge_port_door_open,
      timestamp: data.vehicle_state?.timestamp,
    },
    charge_state: {
      battery_level: data.charge_state?.battery_level,
      charge_limit_soc: data.charge_state?.charge_limit_soc,
      charging_state: data.charge_state?.charging_state,
      timestamp: data.charge_state?.timestamp,
    },
    climate_state: {
      is_climate_on: data.climate_state?.is_climate_on,
      inside_temp: data.climate_state?.inside_temp,
      driver_temp_setting: data.climate_state?.driver_temp_setting,
      timestamp: data.climate_state?.timestamp,
    },
    drive_state: {
      latitude: data.drive_state?.latitude,
      longitude: data.drive_state?.longitude,
      timestamp: data.drive_state?.timestamp,
    },
    address: address ?? undefined,
  };
}

// GET /{vin}/battery shape (https://developer.tessie.com/reference/get-battery). Only the
// fields Fleet API's vehicle_data actually carries are populated — battery_range,
// energy_remaining, pack_voltage etc. have no Fleet API equivalent in this project's
// FleetVehicleData subset, so they're omitted rather than faked.
export interface TessieBatteryShape {
  timestamp?: number;
  battery_level?: number;
}

export function toTessieBattery(data: FleetVehicleData): TessieBatteryShape {
  return {
    timestamp: data.charge_state?.timestamp,
    battery_level: data.charge_state?.battery_level,
  };
}

// GET /{vin}/location shape (https://developer.tessie.com/reference/get-location).
// `saved_location` has no Fleet API equivalent (it's Tessie's own address-book feature) —
// omitted, same reasoning as battery above.
export interface TessieLocationShape {
  latitude?: number;
  longitude?: number;
  address: string | null;
}

export function toTessieLocation(
  data: FleetVehicleData,
  address: string | null,
): TessieLocationShape {
  return {
    latitude: data.drive_state?.latitude,
    longitude: data.drive_state?.longitude,
    address,
  };
}
